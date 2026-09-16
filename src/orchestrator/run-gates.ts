import type { AgentStep, GateStep, SubWorkflowStep } from '../definitions/workflow/workflow-step';
import {
  checkChoice,
  defaultSelection,
  gateItemsOf,
  mergeSelection,
  recordGateOutput,
} from './gate-answers';
import { clearForkMemos } from './output-keys';
import type { GateAnswer, GateSelection } from './run-event';
import { BUDGET_GATE_ID, isTerminal } from './run-event';
import type { WorkflowRun } from './workflow-run';

export async function resolveGate(
  run: WorkflowRun,
  stepId: string,
  approved: boolean,
  note?: string,
  answer?: GateAnswer,
  by?: 'headless',
): Promise<void> {
  // A live agent's mid-run prompt: hand the answer straight back to it -
  // the run's drive loop is still on the stack awaiting the step.
  if (run.pendingPrompt && run.pendingPrompt.stepId === stepId && run.waiting?.stepId === stepId) {
    const prompt = run.pendingPrompt;
    run.pendingPrompt = null;
    run.waiting = null;
    run.status = 'running';
    await run.deps.emit({
      type: 'gate-resolved',
      stepId,
      approved,
      ...(note ? { note } : {}),
    });
    prompt.resolve({ approved, ...(note ? { note } : {}) });
    return;
  }
  if (await forwardToSuspendedChild(run, stepId, approved, note, answer)) {
    return;
  }
  if (!run.waiting || run.waiting.stepId !== stepId) {
    throw new Error(`No gate '${stepId}' is waiting`);
  }
  if (stepId === BUDGET_GATE_ID) {
    run.waiting = null;
    await run.deps.emit({ type: 'gate-resolved', stepId, approved });
    if (approved) {
      // The caller raised the allowance before resolving - same step re-runs the check.
      run.status = 'running';
      await run.drive();
    } else {
      run.status = 'cancelled';
      await run.deps.emit({ type: 'run-cancelled' });
    }
    return;
  }
  const waitingStep = run.waiting.step;
  if (
    run.revivedPrompt === stepId &&
    (waitingStep.kind === 'agent' ||
      waitingStep.kind === 'parallel' ||
      waitingStep.kind === 'foreach')
  ) {
    run.revivedPrompt = null;
    // A mid-run prompt from before a restart: the live session is gone, so
    // re-run the step, carrying the user's answer as feedback. Finished
    // fork branches keep their results; only the asker re-runs.
    run.waiting = null;
    await run.deps.emit({
      type: 'gate-resolved',
      stepId,
      approved,
      ...(note ? { note } : {}),
    });
    if (note?.trim()) {
      run.pendingFeedback = {
        forStepId: waitingStep.id,
        note: `You asked something before this run was interrupted. The answer: ${note}`,
      };
    }
    run.status = 'running';
    run.stepIndex = run.indexOfStep(waitingStep.id);
    await run.drive();
    return;
  }
  // A gate with `select` / `choices`: fold the answer into the live selection and
  // validate the choice BEFORE the gate closes, so a bad answer leaves it open.
  const gate = waitingStep.kind === 'gate' ? waitingStep : undefined;
  // Only a gate that asked for it carries a selection: one with `select`, or an editable one the user actually edited.
  const selection =
    gate && (gate.gate === 'select' || (gate.editable && answer?.selection?.edited))
      ? mergeSelection(run.waiting.selection, answer?.selection)
      : undefined;
  const choice = gate?.choices
    ? checkChoice(gate, answer?.choice, selection ?? { selected: [], dismissed: [] }).id
    : undefined;
  if (choice !== undefined) {
    approved = true; // a choice is an exit, never a "send back"
  }
  const items = run.waiting.items;
  run.waiting = null;
  run.gateOutcomes.set(stepId, approved);
  await run.deps.emit({
    type: 'gate-resolved',
    stepId,
    approved,
    ...(by ? { by } : {}),
    ...(note ? { note } : {}),
    ...(choice !== undefined ? { choice } : {}),
    ...(selection ? { selection } : {}),
  });
  // The gate's own output - `<id>.approved` / `<id>.note` downstream, plus choice / selected / dismissed.
  const recordGate = (rejections: number): void => {
    if (gate) {
      recordGateOutput(
        run.outputs,
        gate,
        { approved, note: note ?? '', rejections },
        { choice, selection, items },
      );
    }
  };

  if (approved) {
    recordGate(run.rejectCounts.get(stepId) ?? 0);
    run.status = 'running';
    run.stepIndex += 1;
    await run.drive();
    return;
  }

  // No cap: a gate only moves when the user acts, so this loop is user-paced
  // by construction - they iterate until the output is right, or cancel.
  const rejects = (run.rejectCounts.get(stepId) ?? 0) + 1;
  run.rejectCounts.set(stepId, rejects);
  recordGate(rejects);
  const target = run.nearestPrecedingAgentStep();
  if (!target) {
    await run.failRun(`'${stepId}' was rejected but there is no earlier agent step to redo`);
    return;
  }
  const feedback = note ?? 'Changes requested at the gate. Revise your previous output.';
  run.pendingFeedback = { forStepId: target.id, note: feedback };
  await run.deps.emit({
    type: 'loop-back',
    fromStepId: stepId,
    toStepId: target.id,
    iteration: rejects,
    reason: 'gate-rejected',
    note: feedback,
  });
  clearForkMemos(run.workflow.steps, run.outputs, run.indexOfStep(target.id), run.stepIndex);
  run.stepIndex = run.indexOfStep(target.id);
  run.status = 'running';
  await run.drive();
}

/** Ticks, dismissals, edits on the open gate - persisted as an event so a restart shows the same list. */
export async function updateGateSelection(
  run: WorkflowRun,
  stepId: string,
  patch: Partial<GateSelection>,
): Promise<GateSelection> {
  const suspended = run.suspendedChild;
  if (suspended && run.waiting?.stepId === stepId && stepId.startsWith(`${suspended.step.id}/`)) {
    return suspended.run.updateGateSelection(stepId.slice(suspended.step.id.length + 1), patch);
  }
  if (!run.waiting || run.waiting.stepId !== stepId) {
    throw new Error(`No gate '${stepId}' is waiting`);
  }
  const step = run.waiting.step;
  if (step.kind !== 'gate' || !(step.gate === 'select' || step.editable)) {
    throw new Error(`Gate '${stepId}' has nothing to select or edit`);
  }
  const selection = mergeSelection(run.waiting.selection, patch);
  run.waiting = { ...run.waiting, selection };
  await run.deps.emit({ type: 'gate-selection-changed', stepId, selection });
  return selection;
}

/**
 * Pause on a question/permission from a live agent. Rendered as a
 * gate card; the answer resolves back into the still-running step. Prompts
 * are serialized so parallel branches take turns.
 */
export function promptUser(
  run: WorkflowRun,
  stepId: string,
  promptKind: 'question' | 'permission',
  question: string,
  options?: readonly string[],
): Promise<{ approved: boolean; note?: string }> {
  const turn = run.promptQueue.then(async () => {
    if (isTerminal(run.status)) {
      return { approved: false };
    }
    await run.deps.emit({
      type: 'gate-opened',
      stepId,
      show: [],
      question,
      promptKind,
      ...(options && options.length > 0 ? { options } : {}),
    });
    run.waiting = {
      stepId,
      step: run.workflow.steps[run.stepIndex] ?? {
        kind: 'gate',
        gate: 'approve',
        id: stepId,
        show: [],
        editable: false,
      },
    };
    run.status = 'waiting-gate';
    if (run.deps.headless) {
      // Nobody to ask: a question gets the fallback answer, a permission escalation is denied.
      run.waiting = null;
      run.status = 'running';
      const approved = promptKind === 'question';
      await run.deps.emit({ type: 'gate-resolved', stepId, approved, by: 'headless' });
      return { approved };
    }
    return new Promise<{ approved: boolean; note?: string }>((resolve) => {
      run.pendingPrompt = { stepId, resolve };
    });
  });
  run.promptQueue = turn.catch(() => undefined);
  return turn;
}

export async function openGate(
  run: WorkflowRun,
  stepId: string,
  show: readonly string[],
  step?: SubWorkflowStep | AgentStep,
): Promise<void> {
  const gateStep = step ?? (run.workflow.steps[run.stepIndex] as GateStep | undefined);
  const gate = gateStep?.kind === 'gate' ? gateStep : undefined;
  // Resolve what the gate shows NOW, so the card renders exactly these - not a guess at "the last report".
  const shown = Object.fromEntries(
    show
      .filter((ref) => ref !== 'diff')
      .map((ref) => [ref, run.valueAtPath(ref)] as const)
      .filter(([, value]) => value !== undefined),
  );
  // A `select` gate freezes its tickable entries here - the selection then names them by key.
  const items = gate?.list ? gateItemsOf(gate.list, (ref) => run.valueAtPath(ref)) : undefined;
  const selection = items ? defaultSelection(items) : undefined;
  run.waiting = {
    stepId,
    step: gateStep ?? { kind: 'gate', gate: 'approve', id: stepId, show, editable: false },
    ...(items ? { items, selection } : {}),
  };
  run.status = 'waiting-gate';
  await run.deps.emit({
    type: 'gate-opened',
    stepId,
    show,
    ...(Object.keys(shown).length > 0 ? { shown } : {}),
    ...(gate?.list && items ? { list: { ref: gate.list, items } } : {}),
    ...(gate?.choices ? { choices: gate.choices } : {}),
    ...(gate?.editable ? { editable: true } : {}),
  });
}

/**
 * What a headless run answers a gate with: the ticks stay as opened
 * (everything not already dismissed), the choice is the one marked default
 * or the first - falling back to a choice that needs no ticks when the
 * default needs some and nothing is left to tick.
 */
export function headlessAnswer(run: WorkflowRun, gate: GateStep): GateAnswer | undefined {
  if (!gate.choices || gate.choices.length === 0) {
    return undefined;
  }
  const preferred = gate.choices.find((choice) => choice.default) ?? gate.choices[0];
  if (!preferred) {
    return undefined;
  }
  const ticked = run.waiting?.selection?.selected.length ?? 0;
  const choice =
    preferred.needs === 'selection' && gate.gate === 'select' && ticked === 0
      ? (gate.choices.find((candidate) => candidate.needs === 'none') ?? preferred)
      : preferred;
  return { choice: choice.id };
}

/** Route a gate resolution into the suspended sub-workflow, then keep the parent moving. */
async function forwardToSuspendedChild(
  run: WorkflowRun,
  stepId: string,
  approved: boolean,
  note?: string,
  answer?: GateAnswer,
): Promise<boolean> {
  const suspended = run.suspendedChild;
  if (
    !suspended ||
    !run.waiting ||
    run.waiting.stepId !== stepId ||
    !stepId.startsWith(`${suspended.step.id}/`)
  ) {
    return false;
  }
  const childStepId = stepId.slice(suspended.step.id.length + 1);
  run.suspendedChild = null;
  run.waiting = null;
  run.status = 'running';
  await suspended.run.resolveGate(childStepId, approved, note, answer);
  const proceed = await suspended.after(suspended.run);
  if (proceed) {
    await run.drive();
  }
  return true;
}
