import type { RunMetrics, StepMetrics, TimedRunEvent, TokenCounts } from './types';

interface StepTally {
  readonly id: string;
  kind: string;
  status: StepMetrics['status'] | 'running';
  startedAt: number;
  endedAt: number;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  toolCalls: number;
  engine?: string;
  model?: string;
}

/**
 * What the log says the run cost: per step (a retried step counts every
 * attempt; a nested step keeps its `parent/child` id) and in total. A step the
 * run left mid-flight has no status and stays out of `steps`; its spend still
 * counts in the totals.
 */
export function metricsOf(
  events: readonly TimedRunEvent[],
  engineOf: (agentName: string) => string | undefined,
  kindOf: (stepId: string) => string | undefined,
): RunMetrics {
  const steps = new Map<string, StepTally>();
  let costUsd = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  const tally = (id: string, at: number): StepTally => {
    let step = steps.get(id);
    if (!step) {
      step = {
        id,
        kind: kindOf(id) ?? 'unknown',
        status: 'running',
        startedAt: at,
        endedAt: at,
        costUsd: 0,
        tokensIn: 0,
        tokensOut: 0,
        toolCalls: 0,
      };
      steps.set(id, step);
    }
    return step;
  };
  for (const event of events) {
    const at = Date.parse(event.at);
    switch (event.type) {
      case 'step-started': {
        const step = tally(event.stepId, at);
        step.kind = event.stepKind;
        step.status = 'running';
        if (event.attempt === 1) {
          step.startedAt = at;
        }
        if (event.agentName) {
          step.engine = engineOf(event.agentName);
        }
        if (event.model) {
          step.model = event.model;
        }
        break;
      }
      case 'step-completed': {
        const step = tally(event.stepId, at);
        step.status = 'done';
        step.endedAt = at;
        break;
      }
      case 'step-failed': {
        const step = tally(event.stepId, at);
        step.status = 'failed';
        step.endedAt = at;
        break;
      }
      case 'step-skipped': {
        const step = tally(event.stepId, at);
        step.status = 'skipped';
        step.endedAt = at;
        break;
      }
      case 'step-usage': {
        const step = tally(event.stepId, at);
        step.tokensIn += event.tokensIn;
        step.tokensOut += event.tokensOut;
        step.costUsd += event.costUsd ?? 0;
        tokensIn += event.tokensIn;
        tokensOut += event.tokensOut;
        costUsd += event.costUsd ?? 0;
        break;
      }
      case 'agent-tool-call':
        tally(event.stepId, at).toolCalls += 1;
        break;
      default:
        break;
    }
  }
  const first = events[0];
  const last = events[events.length - 1];
  return {
    costUsd,
    tokens: tokens(tokensIn, tokensOut),
    durationMs: first && last ? Math.max(0, Date.parse(last.at) - Date.parse(first.at)) : 0,
    steps: [...steps.values()].flatMap((step) =>
      step.status === 'running'
        ? []
        : [
            {
              id: step.id,
              kind: step.kind,
              status: step.status,
              durationMs: Math.max(0, step.endedAt - step.startedAt),
              costUsd: step.costUsd,
              tokens: tokens(step.tokensIn, step.tokensOut),
              toolCalls: step.toolCalls,
              ...(step.engine ? { engine: step.engine } : {}),
              ...(step.model ? { model: step.model } : {}),
            },
          ],
    ),
  };
}

function tokens(tokensIn: number, tokensOut: number): TokenCounts {
  return { tokensIn, tokensOut, total: tokensIn + tokensOut };
}
