import type {
  BranchStep,
  ForEachStep,
  ParallelStep,
  SubWorkflowStep,
  WorkflowStep,
} from '../definitions/workflow/workflow-step';
import type { WorkflowDefinition } from '../definitions/workflow/workflow-definition';
import { runAgentStep } from './agent-step';
import { foreachChildKey, outputKeyOf, recordOutput } from './output-keys';
import { readOutputPath } from './read-output-path';
import { openGate } from './run-gates';
import { branchWorkflowFor } from './run-resume';
import { runScriptStep } from './script-step';
import type { WorkflowRun } from './workflow-run';

export const MAX_NESTING_DEPTH = 3;

/**
 * Fan-out: branches run concurrently; any failure fails the run. A
 * single-step branch (agent/script/sub-workflow/nested fork) dispatches
 * directly; a real chain, or a lone condition/while, runs as its own
 * ephemeral scoped run via runBranchChain. Gates never get here (the parser
 * rejects them).
 */
export async function runParallel(
  run: WorkflowRun,
  step: ParallelStep,
  prefix?: string,
): Promise<boolean> {
  const emitId = prefix ? `${prefix}/${step.id}` : step.id;
  if (emitId.split('/').length > 4) {
    await run.failRun(`Fork nesting is limited to 4 levels ('${emitId}')`);
    return false;
  }
  run.bumpRunCount(step.id);
  await run.deps.emit({
    type: 'step-started',
    stepId: emitId,
    stepKind: 'parallel',
    attempt: run.runCounts.get(step.id) ?? 1,
  });
  // A branch whose LAST step's output already exists completed on a
  // previous pass (crash-resume) - never re-spend on it.
  const pending = step.children.filter((branch) => {
    const last = branch.at(-1) as BranchStep;
    return run.outputs[outputKeyOf(last)] === undefined;
  });
  const policy = step.onFail ?? 'fail';
  const soft = policy !== 'fail';
  const settled = await Promise.all(
    pending.map(async (branch) => {
      const branchId = branch[0].id;
      if (branch.length === 1) {
        const only = branch[0];
        switch (only.kind) {
          case 'agent':
            return {
              id: branchId,
              ok: await runAgentStep(run, only, { emitPrefix: emitId, detached: true, soft }),
            };
          case 'script':
            return {
              id: branchId,
              ok: await runScriptStep(run, only, { emitPrefix: emitId, soft }),
            };
          case 'workflow':
            return { id: branchId, ok: await runSubWorkflowChild(run, only, emitId, soft) };
          case 'parallel':
            // a nested fork applies its OWN policy; a hard failure inside it fails the run
            return { id: branchId, ok: await runParallel(run, only, emitId) };
          case 'condition':
          case 'while':
            break; // a lone control-flow step still needs its own scoped run - falls through
        }
      }
      const child = await runBranchChain(run, branch, `${step.id}:${branchId}`, emitId);
      const quota = child?.interruptedForQuota();
      const ok = child?.currentStatus === 'completed';
      if (child && ok) {
        // Flat merge, same convention as a condition's branch - every inner
        // step's own output becomes readable by its own name downstream.
        Object.assign(run.outputs, branchReport(run, child));
      } else if (quota) {
        await run.interruptForQuota(quota.message, quota.retryAt, quota.cause);
      } else if (!soft) {
        const reason = child?.failureReason();
        await run.failRun(
          `Fork '${step.id}' branch '${branchId}' failed${reason ? `: ${reason}` : ''}`,
        );
      }
      return { id: branchId, ok };
    }),
  );
  if (run.status !== 'running') {
    return false;
  }
  const failed = new Set(settled.filter((entry) => !entry.ok).map((entry) => entry.id));
  if (failed.size > 0 && policy === 'fail') {
    return false; // the failing branch already killed the run
  }
  if (failed.size === step.children.length && step.children.length > 0) {
    await run.failRun(`Fork '${step.id}': every branch failed`);
    return false;
  }
  // The fork's report namespaces every branch by its first step's id, so
  // later steps and conditions address results as '<fork-id>.<branch-id>.<field>'.
  // A branch's value is its LAST step's own output - for a single-step
  // branch that's the same thing; for a chain it's the chain's headline
  // result, while every inner step's own output stays readable by its own
  // bare name too (see the flat merge above).
  const report = Object.fromEntries(
    step.children.map((branch) => {
      const branchId = branch[0].id;
      const last = branch.at(-1) as BranchStep;
      return [
        branchId,
        failed.has(branchId) ? { failed: true } : (run.outputs[outputKeyOf(last)] ?? null),
      ];
    }),
  );
  recordOutput(run.outputs, step, report);
  if (failed.size > 0 && policy === 'ask') {
    // partial results are recorded - the user decides whether they suffice
    await openGate(run, step.id, [outputKeyOf(step)]);
    return false;
  }
  await run.deps.emit({ type: 'step-completed', stepId: emitId, report });
  return true;
}

/** A sub-workflow inside a fork: same as the pipeline case, minus blocking loops and stepIndex. */
export async function runSubWorkflowChild(
  run: WorkflowRun,
  step: SubWorkflowStep,
  prefix: string,
  soft?: boolean,
): Promise<boolean> {
  const emitId = `${prefix}/${step.id}`;
  run.bumpRunCount(step.id);
  const childWorkflow = await resolveSubWorkflow(run, step, soft);
  if (!childWorkflow) {
    return false;
  }
  if (childWorkflow.steps.some((child) => child.kind === 'gate')) {
    return run.stepFailure(
      `Sub-workflow '${childWorkflow.name}' has gates - those pause the pipeline and can't run inside a fork`,
      soft,
    );
  }
  await run.deps.emit({
    type: 'step-started',
    stepId: emitId,
    stepKind: 'workflow',
    attempt: 1,
  });
  // No checkBudget: the fork-level budget check governs; a branch pausing
  // at a budget gate would deadlock its siblings.
  const child = await run.startChild(childWorkflow, emitId, {
    ...run.deps,
    checkBudget: undefined,
  });
  if (run.status !== 'running') {
    return false;
  }
  if (child.currentStatus !== 'completed') {
    const quota = child.interruptedForQuota();
    if (quota) {
      await run.interruptForQuota(quota.message, quota.retryAt, quota.cause);
      return false;
    }
    return run.stepFailure(`Sub-workflow '${step.id}' ${child.currentStatus}`, soft);
  }
  const report = branchReport(run, child);
  recordOutput(run.outputs, step, report);
  await run.deps.emit({ type: 'step-completed', stepId: emitId, report });
  return true;
}

/**
 * The sub-workflow a step names, shared by the pipeline and fork cases. Null
 * once the nesting cap or an unknown name has already failed the run (or,
 * under a soft on_fail policy, just the branch).
 */
export async function resolveSubWorkflow(
  run: WorkflowRun,
  step: SubWorkflowStep,
  soft: boolean | undefined,
): Promise<WorkflowDefinition | null> {
  if (run.depth >= MAX_NESTING_DEPTH) {
    await run.stepFailure(`Workflow nesting is limited to ${MAX_NESTING_DEPTH} levels`, soft);
    return null;
  }
  const childWorkflow = run.deps.resolveWorkflow(step.workflow);
  if (!childWorkflow) {
    await run.stepFailure(`Unknown sub-workflow '${step.workflow}' in step '${step.id}'`, soft);
    return null;
  }
  return childWorkflow;
}

/**
 * Dynamic fan-out: one agent per item of the array at `path`, all
 * concurrent. Item i runs as '<id>/<i>' with the item exposed under
 * `itemName`; results land namespaced as outputs['<id>']['<i>'].
 */
export async function runForEach(run: WorkflowRun, step: ForEachStep): Promise<boolean> {
  run.bumpRunCount(step.id);
  const value = readOutputPath(run.outputs, step.path);
  if (value !== undefined && !Array.isArray(value)) {
    await run.failRun(`for_each '${step.id}': '${step.path}' is not a list`);
    return false;
  }
  const items = (value ?? []).slice(0, step.maxItems);
  await run.deps.emit({
    type: 'step-started',
    stepId: step.id,
    stepKind: 'foreach',
    attempt: run.runCounts.get(step.id) ?? 1,
  });
  // Items whose result is already recorded finished on a previous pass
  // (crash-resume) - never re-spend on them.
  const pending = items
    .map((item, index) => ({ item, index: index + 1 }))
    .filter(({ index }) => run.outputs[foreachChildKey(step.id, index)] === undefined);
  const policy = step.onFail ?? 'fail';
  const soft = policy !== 'fail';
  const settled = await Promise.all(
    pending.map(async ({ item, index }) => ({
      index,
      ok: await runAgentStep(
        run,
        {
          ...step.template,
          id: String(index),
          output: foreachChildKey(step.id, index),
        },
        {
          emitPrefix: step.id,
          detached: true,
          extraOutputs: { [step.itemName]: item },
          soft,
        },
      ),
    })),
  );
  if (run.status !== 'running') {
    return false;
  }
  const failed = new Set(settled.filter((entry) => !entry.ok).map((entry) => entry.index));
  if (failed.size > 0 && policy === 'fail') {
    return false; // the failing item already killed the run
  }
  if (failed.size === items.length && items.length > 0) {
    await run.failRun(`for_each '${step.id}': every item failed`);
    return false;
  }
  const report = Object.fromEntries(
    items.map((_item, index) => [
      String(index + 1),
      failed.has(index + 1)
        ? { failed: true }
        : (run.outputs[foreachChildKey(step.id, index + 1)] ?? null),
    ]),
  );
  recordOutput(run.outputs, step, report);
  if (failed.size > 0 && policy === 'ask') {
    await openGate(run, step.id, [outputKeyOf(step)]);
    return false;
  }
  await run.deps.emit({ type: 'step-completed', stepId: step.id, report });
  return true;
}

/**
 * Runs a branch's steps as an ephemeral, self-contained sequential run -
 * shared by a condition's chosen lane and one parallel branch. A single
 * step still dispatches directly (see runParallel); this is for a real
 * chain (2+ steps) or a lone condition/while, which need their own scoped
 * step index so their internal jumps mean something. The lane starts out
 * seeing everything the pipeline has produced so far, so a step in it reads
 * upstream outputs exactly like a sibling would. Null when nesting is
 * already at the limit; otherwise the finished (or paused) child.
 */
export async function runBranchChain(
  run: WorkflowRun,
  steps: readonly WorkflowStep[],
  namePart: string,
  emitPrefix: string,
): Promise<WorkflowRun | null> {
  if (run.depth >= MAX_NESTING_DEPTH) {
    return null;
  }
  return run.startChild(branchWorkflowFor(run.workflow, steps, namePart), emitPrefix, {
    ...run.deps,
    checkBudget: undefined,
  });
}

/** What a fork branch / condition lane contributed: the child's outputs minus what it inherited unchanged. */
export function branchReport(
  run: WorkflowRun,
  child: WorkflowRun,
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(child.finalReport()).filter(([key, value]) => run.outputs[key] !== value),
  );
}

/** A fork loops back when ANY branch/item report says blocking: true. */
export async function handleForkBlocking(
  run: WorkflowRun,
  step: ParallelStep | ForEachStep,
): Promise<boolean> {
  const report = run.outputs[outputKeyOf(step)];
  if (!step.onBlocking || typeof report !== 'object' || report === null) {
    run.stepIndex += 1;
    return true;
  }
  const blockingParts = Object.fromEntries(
    Object.entries(report as Record<string, unknown>).filter(([, value]) =>
      isBlockingReport(value),
    ),
  );
  if (Object.keys(blockingParts).length === 0) {
    run.stepIndex += 1;
    return true;
  }
  return run.loopBackOnBlocking(step.id, step.onBlocking, blockingParts);
}

export function isBlockingReport(report: unknown): boolean {
  return (
    typeof report === 'object' &&
    report !== null &&
    (report as Record<string, unknown>)['blocking'] === true
  );
}
