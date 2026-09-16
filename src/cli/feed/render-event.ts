import type { RunEvent } from '../../orchestrator/run-event';
import type { TimedRunEvent } from '../../runner/types';
import { shortFailure } from '../../shared/failure-text';
import type { Output } from '../output';
import { formatCost, formatDuration } from '../output';

/** What the text feed remembers between events: when a step started, what it cost, who ran it. */
export class FeedState {
  private readonly startedAt = new Map<string, number>();
  private readonly cost = new Map<string, number>();
  private readonly labels = new Map<string, string>();
  private total = 0;

  note(event: TimedRunEvent): void {
    if (event.type === 'step-started') {
      this.startedAt.set(event.stepId, Date.parse(event.at));
      this.labels.set(event.stepId, event.agentName ?? event.stepKind);
      this.cost.set(event.stepId, 0);
    } else if (event.type === 'step-usage' && event.costUsd !== undefined) {
      this.cost.set(event.stepId, (this.cost.get(event.stepId) ?? 0) + event.costUsd);
      this.total += event.costUsd;
    }
  }

  durationOf(stepId: string, at: string): string {
    const started = this.startedAt.get(stepId);
    return started === undefined ? '' : formatDuration(Date.parse(at) - started);
  }

  costOf(stepId: string): string {
    const cost = this.cost.get(stepId);
    return cost ? formatCost(cost) : '';
  }

  labelOf(stepId: string): string {
    return this.labels.get(stepId) ?? '';
  }

  get totalCost(): number {
    return this.total;
  }
}

const PAD = 14;
const step = (id: string): string => id.padEnd(PAD);
const words = (...parts: ReadonlyArray<string | undefined>): string =>
  parts.filter(Boolean).join(' ');

/**
 * One feed line per event (`investigate  ✓ 38s $0.05`). Returns nothing for
 * events the text feed hides; --verbose adds agent prose and tool calls.
 */
export function renderEvent(
  event: TimedRunEvent,
  state: FeedState,
  out: Output,
  verbose: boolean,
): string | undefined {
  switch (event.type) {
    case 'run-started':
      return out.dim(`workflow ${event.workflowName}`);
    case 'step-started':
      return out.dim(
        `${step(event.stepId)}… ${words(event.agentName ?? event.stepKind, event.attempt > 1 ? `(attempt ${event.attempt})` : undefined)}`,
      );
    case 'step-completed':
      return `${step(event.stepId)}${out.ok('✓')} ${words(state.durationOf(event.stepId, event.at), state.costOf(event.stepId), event.reportIssues?.length ? out.warn(`report: ${event.reportIssues.join('; ')}`) : undefined)}`;
    case 'step-failed':
      return `${step(event.stepId)}${out.bad('✗')} ${failureLine(event.message, verbose, out)}`;
    case 'step-skipped':
      return out.dim(`${step(event.stepId)}– skipped: ${event.reason}`);
    case 'step-summary':
      return `${' '.repeat(PAD)}${event.text}`;
    case 'gate-opened': {
      const asked = event.promptKind === 'permission' ? 'permission' : 'question';
      const detail = event.question ? `${asked}: ${event.question}` : gateLine(event);
      return `${step(event.stepId)}${out.warn('⏸')} ${detail}`;
    }
    case 'gate-selection-changed':
      return `${step(event.stepId)}${out.dim(`☑ ${event.selection.selected.length} ticked${event.selection.dismissed.length > 0 ? ` · ${event.selection.dismissed.length} dismissed` : ''}`)}`;
    case 'gate-resolved':
      return `${step(event.stepId)}${event.approved ? out.ok('✓ approved') : out.bad('✗ rejected')}${event.by === 'headless' ? out.dim(' (headless)') : ''}${event.choice ? ` → ${event.choice}` : ''}${event.note ? ` - ${event.note}` : ''}`;
    case 'loop-back':
      return out.dim(
        `${' '.repeat(PAD)}↺ ${event.fromStepId} → ${event.toStepId} (${event.reason}, pass ${event.iteration})`,
      );
    case 'condition-evaluated':
      return out.dim(
        `${step(event.stepId)}${event.path} = ${JSON.stringify(event.value)} → ${event.result}${event.to ? ` → ${event.to}` : ''}`,
      );
    case 'hook-ran':
      return out.dim(
        `${' '.repeat(PAD)}hook ${event.hook}: ${event.command} → exit ${event.exitCode}`,
      );
    case 'run-completed': {
      const summary = summaryOf(event.output);
      return `${out.ok('run completed')}${summary ? ` - ${summary}` : ''}`;
    }
    case 'run-failed': {
      const summary = summaryOf(event.output);
      return out.bad(`run failed: ${event.message}${summary ? ` - ${summary}` : ''}`);
    }
    case 'run-cancelled':
      return out.warn('run cancelled');
    case 'run-interrupted':
      return out.warn(
        `run interrupted: ${event.reason}${event.retryAt ? ` (retry after ${event.retryAt})` : ''}`,
      );
    case 'run-resumed':
      return out.dim('run resumed');
    case 'agent-text':
      return verbose ? out.dim(indent(event.text)) : undefined;
    case 'agent-tool-call':
      return verbose
        ? out.dim(`${' '.repeat(PAD)}⚙ ${words(event.toolName, event.detail)}`)
        : undefined;
    case 'agent-tool-result':
      return verbose && event.isError ? out.dim(`${' '.repeat(PAD)}⚙ tool error`) : undefined;
    case 'agent-text-partial':
    case 'step-usage':
      return undefined;
  }
}

/** What a plain gate shows: its references, the items to tick, the exits it offers. */
function gateLine(event: Extract<RunEvent, { type: 'gate-opened' }>): string {
  const items = event.list
    ? ` · ${event.list.items.length} item${event.list.items.length === 1 ? '' : 's'} to tick`
    : '';
  const choices = event.choices
    ? ` · choices: ${event.choices.map((choice) => choice.id).join(', ')}`
    : '';
  return `gate - shows ${event.show.join(', ') || 'nothing'}${items}${choices}`;
}

function indent(text: string): string {
  return text
    .trim()
    .split('\n')
    .map((line) => `${' '.repeat(PAD)}${line}`)
    .join('\n');
}

/** The `_summary` of a run output, when it has one. */
function summaryOf(output: Readonly<Record<string, unknown>> | undefined): string | undefined {
  const summary = output?.['_summary'];
  return typeof summary === 'string' && summary.trim().length > 0 ? summary.trim() : undefined;
}

/** The shared short form, plus the CLI's own pointer to the rest. */
export function failureLine(message: string, verbose: boolean, out: Output): string {
  if (verbose) {
    return message;
  }
  const { text, hasMore } = shortFailure(message);
  return hasMore ? `${text} ${out.dim('(--verbose for the full output)')}` : text;
}
