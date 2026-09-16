import type { WorkflowDefinition } from '../definitions/workflow/workflow-definition';
import type { WorkflowStep } from '../definitions/workflow/workflow-step';
import type { GateItem, GateSelection, RunEvent, RunStatus } from './run-event';
import { BUDGET_GATE_ID } from './run-event';
import { defaultSelection, recordGateOutput } from './gate-answers';
import { clearForkMemos, foreachChildKey, laneHeadline, recordOutput } from './output-keys';

export interface DerivedRunState {
  readonly stepIndex: number;
  readonly status: RunStatus;
  readonly outputs: Readonly<Record<string, unknown>>;
  readonly loopCounts: ReadonlyMap<string, number>;
  readonly rejectCounts: ReadonlyMap<string, number>;
  readonly runCounts: ReadonlyMap<string, number>;
  readonly gateOutcomes: ReadonlyMap<string, boolean>;
  /** Set when the open gate is an agent's mid-run prompt (question/permission). */
  readonly waitingPromptKind: 'question' | 'permission' | null;
  readonly pendingFeedback: { forStepId: string; note: string } | null;
  readonly waitingStepId: string | null;
  /** The open gate's checkable items and the user's ticks so far. */
  readonly waitingItems: readonly GateItem[] | null;
  readonly waitingSelection: GateSelection | null;
}

/**
 * Reduces a persisted event log back into resumable run state. Child events
 * (step ids containing '/') are ignored - sub-workflow results surface as the
 * parent step's completion.
 */
export function deriveRunState(
  workflow: WorkflowDefinition,
  events: readonly RunEvent[],
): DerivedRunState {
  const outputs: Record<string, unknown> = {};
  const loopCounts = new Map<string, number>();
  const rejectCounts = new Map<string, number>();
  const runCounts = new Map<string, number>();
  const gateOutcomes = new Map<string, boolean>();
  let waitingPromptKind: 'question' | 'permission' | null = null;
  let stepIndex = 0;
  let status: RunStatus = 'idle';
  let waitingStepId: string | null = null;
  let waitingStatus: RunStatus = 'waiting-gate';
  let pendingFeedback: { forStepId: string; note: string } | null = null;
  /** Items per opened gate (any depth) - a resolved gate's output needs them to turn keys back into values. */
  const openItems = new Map<string, readonly GateItem[]>();
  let waitingItems: readonly GateItem[] | null = null;
  let waitingSelection: GateSelection | null = null;

  const indexOf = (stepId: string): number =>
    workflow.steps.findIndex((step) => step.id === stepId);
  const isChildEvent = (stepId: string): boolean => stepId.includes('/');
  /** The lane step a scoped id names ('<cond>/<step>', any depth) - undefined for a sub-workflow's inner steps or for-each items. */
  const laneStepOf = (stepId: string): WorkflowStep | undefined => {
    let scope: readonly WorkflowStep[] = workflow.steps;
    let node: WorkflowStep | undefined;
    for (const segment of stepId.split('/')) {
      node = scope.find((candidate) => candidate.id === segment);
      if (!node) {
        return undefined;
      }
      scope = branchScopeOf(node);
    }
    return node;
  };

  for (const event of events) {
    switch (event.type) {
      case 'run-started':
        status = 'running';
        break;
      case 'step-started':
        if (!isChildEvent(event.stepId) && event.attempt === 1) {
          runCounts.set(event.stepId, (runCounts.get(event.stepId) ?? 0) + 1);
        }
        break;
      case 'step-skipped': {
        if (isChildEvent(event.stepId)) break;
        const index = indexOf(event.stepId);
        if (index >= 0) {
          stepIndex = index + 1;
        }
        const skipped = workflow.steps[index];
        if (skipped?.kind === 'goto') {
          // a goto that had used up its jumps - it fell through
          recordOutput(outputs, skipped, {
            target: skipped.targetStepId,
            jumped: false,
            iteration: loopCounts.get(skipped.id) ?? 0,
            maxLoops: skipped.maxLoops,
          });
        }
        break;
      }
      case 'step-completed': {
        if (isChildEvent(event.stepId)) {
          // A branch's output must survive resume, or the whole fan-out (or
          // condition) re-runs (and re-spends) on every crash. Walk the id
          // segments so nested forks/conditions and multi-step chains resolve
          // too; a sub-workflow's inner steps don't (their ids belong to
          // another definition) and are skipped.
          const segments = event.stepId.split('/');
          let scope: readonly WorkflowStep[] = workflow.steps;
          let node: WorkflowStep | undefined;
          let foreachItem: string | null = null;
          for (const [position, segment] of segments.entries()) {
            node = scope.find((candidate) => candidate.id === segment);
            if (!node) {
              break;
            }
            if (node.kind === 'foreach' && position < segments.length - 1) {
              // '<id>/<i>' - an item's result; the keys are synthetic, not steps
              foreachItem = foreachChildKey(node.id, segments[position + 1] ?? '');
              break;
            }
            scope = branchScopeOf(node);
          }
          if (foreachItem) {
            outputs[foreachItem] = event.report ?? null;
          } else if (node && producesOutput(node)) {
            recordOutput(outputs, node, event.report ?? null);
          }
          break;
        }
        const index = indexOf(event.stepId);
        if (index < 0) break;
        const step = workflow.steps[index];
        if (step?.kind === 'condition') {
          // Its lane just finished (the event carries no report): fold the ran
          // side's headline into the output recorded at condition-evaluated - as live.
          const own = outputs[step.id];
          const recorded = own && typeof own === 'object' ? (own as Record<string, unknown>) : {};
          const side = recorded.branch === 'else' ? step.else : step.then;
          recordOutput(outputs, step, {
            ...recorded,
            output: side?.kind === 'steps' ? laneHeadline(side.steps, outputs) : null,
          });
        } else if (step && producesOutput(step)) {
          recordOutput(outputs, step, event.report ?? null);
        }
        stepIndex = index + 1;
        pendingFeedback = null;
        break;
      }
      case 'gate-opened':
        waitingPromptKind = event.promptKind ?? null;
        if (event.list) {
          openItems.set(event.stepId, event.list.items);
        }
        waitingItems = event.list?.items ?? null;
        waitingSelection = event.list ? defaultSelection(event.list.items) : null;
        if (isChildEvent(event.stepId)) {
          // a sub-workflow's gate suspends the parent AT the sub-workflow step
          status = 'waiting-gate';
          waitingStatus = 'waiting-gate';
          waitingStepId = event.stepId;
          const rootIndex = indexOf(event.stepId.split('/')[0] ?? '');
          if (rootIndex >= 0) {
            stepIndex = rootIndex;
          }
          break;
        }
        status = 'waiting-gate';
        waitingStatus = 'waiting-gate';
        waitingStepId = event.stepId;
        // The budget gate has no step of its own - the current index IS the
        // paused step. A real gate sits at its index in the list.
        if (event.stepId !== BUDGET_GATE_ID) {
          stepIndex = Math.max(indexOf(event.stepId), 0);
        }
        break;
      case 'gate-selection-changed':
        if (waitingStepId === event.stepId) {
          waitingSelection = event.selection;
        }
        break;
      case 'gate-resolved':
        waitingPromptKind = null;
        waitingItems = null;
        waitingSelection = null;
        if (isChildEvent(event.stepId)) {
          waitingStepId = null;
          status = 'running';
          // a lane's gate writes its outcome under its own id, like live
          const gate = laneStepOf(event.stepId);
          if (gate?.kind === 'gate') {
            if (!event.approved) {
              rejectCounts.set(event.stepId, (rejectCounts.get(event.stepId) ?? 0) + 1);
            }
            recordGateOutput(
              outputs,
              gate,
              {
                approved: event.approved,
                note: event.note ?? '',
                rejections: rejectCounts.get(event.stepId) ?? 0,
              },
              {
                choice: event.choice,
                selection: event.selection,
                items: openItems.get(event.stepId),
              },
            );
          }
          break;
        }
        if (event.stepId !== BUDGET_GATE_ID) {
          gateOutcomes.set(event.stepId, event.approved);
        }
        waitingStepId = null;
        status = 'running';
        if (event.stepId === BUDGET_GATE_ID) {
          break; // approve re-runs the SAME step; reject ends the run via run-cancelled
        }
        if (event.approved) {
          stepIndex = Math.max(indexOf(event.stepId), 0) + 1;
        } else {
          rejectCounts.set(event.stepId, (rejectCounts.get(event.stepId) ?? 0) + 1);
        }
        {
          const gate = workflow.steps[indexOf(event.stepId)];
          if (gate?.kind === 'gate') {
            recordGateOutput(
              outputs,
              gate,
              {
                approved: event.approved,
                note: event.note ?? '',
                rejections: rejectCounts.get(event.stepId) ?? 0,
              },
              {
                choice: event.choice,
                selection: event.selection,
                items: openItems.get(event.stepId),
              },
            );
          }
        }
        break;
      case 'loop-back': {
        if (isChildEvent(event.toStepId)) break;
        if (
          event.reason === 'blocking-review' ||
          event.reason === 'while' ||
          event.reason === 'goto'
        ) {
          loopCounts.set(event.fromStepId, event.iteration);
        }
        if (event.reason === 'goto') {
          const from = workflow.steps[indexOf(event.fromStepId)];
          if (from?.kind === 'goto') {
            recordOutput(outputs, from, {
              target: event.toStepId,
              jumped: true,
              iteration: event.iteration,
              maxLoops: from.maxLoops,
            });
          }
        }
        const target = indexOf(event.toStepId);
        if (target >= 0) {
          clearForkMemos(workflow.steps, outputs, target, stepIndex);
          stepIndex = target;
        }
        if (event.note) {
          pendingFeedback = { forStepId: event.toStepId, note: event.note };
        }
        status = 'running';
        break;
      }
      case 'condition-evaluated': {
        if (isChildEvent(event.stepId)) break; // a lane's own if/while - the lane's run replays it
        const checked = workflow.steps[indexOf(event.stepId)];
        if (checked?.kind === 'while') {
          // the loop's own output; the loop-back that follows (if it looped) moves stepIndex
          const count = loopCounts.get(checked.id) ?? 0;
          recordOutput(outputs, checked, {
            path: event.path,
            value: event.value,
            looped: event.result,
            iteration: event.result ? count + 1 : count,
            maxLoops: checked.maxLoops,
          });
          break;
        }
        if (checked?.kind === 'condition') {
          recordOutput(outputs, checked, {
            path: event.path,
            value: event.value,
            result: event.result,
            branch: event.result ? 'then' : 'else',
            ...(event.to ? { jumpedTo: event.to } : {}),
          });
        }
        // A goto branch jumps immediately (unchanged). An embedded branch
        // (no `to`) hasn't run yet at this point - stepIndex stays on the
        // condition itself so a crash mid-branch re-enters and reruns it; the
        // branch's own trailing step-completed advances stepIndex once it
        // actually finishes.
        if (event.to) {
          const target = indexOf(event.to);
          stepIndex = target >= 0 ? target : Math.max(indexOf(event.stepId), 0) + 1;
        }
        break;
      }
      case 'run-completed':
        status = 'completed';
        break;
      case 'run-failed':
        status = 'failed';
        break;
      case 'run-cancelled':
      case 'run-interrupted':
        status = 'cancelled';
        break;
      case 'run-resumed':
        // Continue exactly where the run stopped: back to the open gate,
        // or running (an interrupted step re-runs from its input snapshot).
        status = waitingStepId ? waitingStatus : 'running';
        break;
      default:
        break;
    }
  }

  return {
    stepIndex,
    status,
    outputs,
    loopCounts,
    rejectCounts,
    gateOutcomes,
    waitingPromptKind,
    runCounts,
    pendingFeedback,
    waitingStepId,
    waitingItems,
    waitingSelection,
  };
}

/** Steps whose completion carries a result - a gate or flow step's completion is a marker only. */
function producesOutput(step: WorkflowStep): boolean {
  return (
    step.kind !== 'gate' && step.kind !== 'goto' && step.kind !== 'finish' && step.kind !== 'fail'
  );
}

/**
 * The steps a scoped child event's next id segment could resolve against -
 * a parallel's branches flattened into one list (ids are unique across a
 * fork, so this is unambiguous), or a condition's embedded then/else steps
 * (both sides searched - the id alone doesn't say which branch produced it).
 * Anything else (agent/script/workflow/while, or a goto condition)
 * has no further steps to descend into.
 */
function branchScopeOf(node: WorkflowStep): readonly WorkflowStep[] {
  if (node.kind === 'parallel') {
    return node.children.flat();
  }
  if (node.kind === 'condition') {
    return [
      ...(node.then.kind === 'steps' ? node.then.steps : []),
      ...(node.else?.kind === 'steps' ? node.else.steps : []),
    ];
  }
  return [];
}
