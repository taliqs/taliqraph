import type { GateSelection, RunEvent } from '../orchestrator/run-event';
import type { WorkflowRun } from '../orchestrator/workflow-run';
import type { GateDecision, GateRequest } from './types';

type GateOpened = Extract<RunEvent, { type: 'gate-opened' }>;

/** The pause as the host sees it, from the event that opened it. */
export function gateRequestOf(event: GateOpened): GateRequest {
  const kind: GateRequest['kind'] =
    event.promptKind === 'question'
      ? 'question'
      : event.promptKind === 'permission'
        ? 'permission'
        : event.choices
          ? 'choice'
          : event.list
            ? 'select'
            : 'approve';
  const selection = event.list
    ? {
        selected: event.list.items.map((item) => item.key),
        dismissed: [],
      }
    : undefined;
  return {
    stepId: event.stepId,
    kind,
    show: event.show,
    ...(event.shown ? { shown: event.shown } : {}),
    ...(event.question ? { question: event.question } : {}),
    ...(event.options ? { suggestions: event.options } : {}),
    ...(event.list ? { items: event.list.items } : {}),
    ...(event.choices ? { choices: event.choices } : {}),
    ...(event.editable ? { editable: true } : {}),
    ...(selection ? { selection } : {}),
  };
}

/** The open gate of a log: the last gate-opened with no gate-resolved after it. */
export function openGateOf(events: readonly RunEvent[]): GateOpened | undefined {
  let open: GateOpened | undefined;
  for (const event of events) {
    if (event.type === 'gate-opened') {
      open = event;
    } else if (event.type === 'gate-resolved' && open?.stepId === event.stepId) {
      open = undefined;
    }
  }
  return open;
}

/** Hands the decision to the run: the ticks first, when there are any, then the resolution. */
export async function applyGateDecision(
  run: WorkflowRun,
  request: GateRequest,
  decision: GateDecision,
): Promise<void> {
  const patch: Partial<GateSelection> = {
    ...(decision.selected ? { selected: decision.selected } : {}),
    ...(decision.dismissed ? { dismissed: decision.dismissed } : {}),
    ...(decision.edited ? { edited: decision.edited } : {}),
  };
  if (Object.keys(patch).length > 0 && (request.kind === 'select' || request.editable)) {
    await run.updateGateSelection(request.stepId, patch);
  }
  const note = request.kind === 'question' ? (decision.answer ?? decision.note) : decision.note;
  await run.resolveGate(
    request.stepId,
    decision.approved,
    note,
    decision.choice ? { choice: decision.choice } : undefined,
  );
}
