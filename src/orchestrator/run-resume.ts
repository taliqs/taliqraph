import type { ConditionBranch, WorkflowStep } from '../definitions/workflow/workflow-step';
import type { WorkflowDefinition } from '../definitions/workflow/workflow-definition';
import { deriveRunState } from './derive-run-state';
import { defaultSelection } from './gate-answers';
import type { RunEvent } from './run-event';
import { BUDGET_GATE_ID } from './run-event';
import type { WorkflowRun } from './workflow-run';

/** Loads a persisted event log into a fresh run: outputs, counters, and the gate or paused child it stopped on. */
export function restoreRun(run: WorkflowRun, events: readonly RunEvent[]): void {
  const { workflow, deps } = run;
  const state = deriveRunState(workflow, events);
  Object.assign(run.outputs, state.outputs);
  for (const [key, value] of state.loopCounts) run.loopCounts.set(key, value);
  for (const [key, value] of state.rejectCounts) run.rejectCounts.set(key, value);
  for (const [key, value] of state.runCounts) run.runCounts.set(key, value);
  for (const [key, value] of state.gateOutcomes) run.gateOutcomes.set(key, value);
  run.pendingFeedback = state.pendingFeedback;
  run.stepIndex = state.stepIndex;
  run.status = state.status;
  if (state.waitingStepId === BUDGET_GATE_ID) {
    const step = workflow.steps[state.stepIndex];
    if (step && (step.kind === 'agent' || step.kind === 'parallel' || step.kind === 'foreach')) {
      run.waiting = { stepId: BUDGET_GATE_ID, step };
    }
  } else if (state.waitingStepId && state.waitingStepId.includes('/')) {
    // A sub-workflow's own gate/permission was open - rebuild that child run
    // from its slice of the event log and re-suspend on it.
    const rootId = state.waitingStepId.split('/')[0] ?? '';
    const step = run.stepById(rootId);
    if (
      state.waitingPromptKind &&
      step &&
      (step.kind === 'parallel' || step.kind === 'foreach' || step.kind === 'agent')
    ) {
      // a branch's mid-run prompt - the session died with the old process;
      // resolveGate revives it by re-running the step with the answer
      run.waiting = { stepId: state.waitingStepId, step };
      run.revivedPrompt = state.waitingStepId;
    }
    const childWorkflow =
      step?.kind === 'workflow' ? deps.resolveWorkflow(step.workflow) : undefined;
    if (step?.kind === 'workflow' && childWorkflow) {
      const child = run.resumeChild(childWorkflow, rootId, events);
      run.suspendedChild = {
        step,
        run: child,
        after: (lane) => run.afterChildProgress(step, lane),
      };
      run.waiting = {
        stepId: state.waitingStepId,
        step,
      };
    } else if (step?.kind === 'condition') {
      // A condition's embedded lane paused at ITS gate/permission: the
      // side it took is on record, so rebuild that lane's run from its slice
      // of the log - seeing everything the pipeline had produced, as it did
      // live - and re-suspend on it.
      const decided = [...events]
        .reverse()
        .find((event) => event.type === 'condition-evaluated' && event.stepId === rootId);
      let branch: ConditionBranch | undefined;
      if (decided?.type === 'condition-evaluated') {
        branch = decided.result ? step.then : step.else;
      }
      if (branch?.kind === 'steps' && branch.steps.length > 0) {
        const child = run.resumeChild(
          branchWorkflowFor(workflow, branch.steps, rootId),
          rootId,
          events,
          { ...deps, checkBudget: undefined },
        );
        run.suspendedChild = {
          step,
          run: child,
          after: (lane) => run.afterConditionBranch(step, lane),
        };
        run.waiting = {
          stepId: state.waitingStepId,
          step,
        };
      }
    }
  } else if (state.waitingStepId) {
    const step = run.stepById(state.waitingStepId);
    const promptStep =
      step && (step.kind === 'agent' || step.kind === 'parallel' || step.kind === 'foreach');
    if (promptStep && !state.waitingPromptKind) {
      // a blocking-exhausted "ask me" gate on this step - generic handling
      run.waiting = { stepId: step.id, step };
    } else if (step && (step.kind === 'gate' || step.kind === 'workflow' || promptStep)) {
      run.waiting = {
        stepId: step.id,
        step,
        ...(step.kind === 'gate' && state.waitingItems
          ? {
              items: state.waitingItems,
              selection: state.waitingSelection ?? defaultSelection(state.waitingItems),
            }
          : {}),
      };
      if (promptStep && state.waitingPromptKind) {
        run.revivedPrompt = step.id;
      }
    }
  }
}

/** The throwaway definition a branch's steps run as - same defaults and scope as the pipeline they belong to. */
export function branchWorkflowFor(
  parent: WorkflowDefinition,
  steps: readonly WorkflowStep[],
  namePart: string,
): WorkflowDefinition {
  return {
    name: `${parent.name}:${namePart}`,
    title: namePart,
    scope: parent.scope,
    steps,
  };
}

/** The inverse of scopeChildEvent: one child's slice of a parent log, prefix stripped. */
export function unscopeChildEvents(parentStepId: string, events: readonly RunEvent[]): RunEvent[] {
  const prefix = `${parentStepId}/`;
  const strip = (id: string): string => id.slice(prefix.length);
  const result: RunEvent[] = [];
  for (const event of events) {
    if (event.type === 'loop-back') {
      if (event.fromStepId.startsWith(prefix) && event.toStepId.startsWith(prefix)) {
        result.push({
          ...event,
          fromStepId: strip(event.fromStepId),
          toStepId: strip(event.toStepId),
        });
      }
      continue;
    }
    if ('stepId' in event && typeof event.stepId === 'string' && event.stepId.startsWith(prefix)) {
      result.push({ ...event, stepId: strip(event.stepId) });
    }
  }
  return result;
}

export function scopeChildEvent(parentStepId: string, event: RunEvent): RunEvent | null {
  switch (event.type) {
    case 'run-started':
    case 'run-completed':
    case 'run-failed':
    case 'run-cancelled':
      return null;
    case 'loop-back':
      return {
        ...event,
        fromStepId: `${parentStepId}/${event.fromStepId}`,
        toStepId: `${parentStepId}/${event.toStepId}`,
      };
    default:
      return 'stepId' in event ? { ...event, stepId: `${parentStepId}/${event.stepId}` } : event;
  }
}
