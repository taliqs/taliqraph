import type { RunResult, TimedRunEvent } from '../../runner/types';
import { createDefaultEngines } from '../../engines/default-engines';
import { TaskInputError } from '../../steps/resolve-task-inputs';
import { WorkflowInvalid } from '../../runner/types';
import { runWorkflow } from '../../runner/run-workflow';
import { EXIT } from '../exit-codes';
import { FeedState, renderEvent } from '../feed/render-event';
import type { Output } from '../output';
import { formatCost, formatDuration } from '../output';
import { terminalPrompt } from './terminal-prompt';
import { readMcpServersFile } from './mcp-servers-file';
import type { GatePrompt } from './terminal-gate';
import { terminalGate } from './terminal-gate';

export type OutputFormat = 'text' | 'json' | 'stream-json';

export const OUTPUT_FORMATS: readonly OutputFormat[] = ['text', 'json', 'stream-json'];

export interface RunOptions {
  readonly cwd?: string;
  /** `--mcp-servers <file>`: the servers to offer the agents. */
  readonly mcpServersFile?: string;
  readonly verbose?: boolean;
  readonly outputFormat: OutputFormat;
  /** `-p`: nobody is watching, so gates answer themselves and over budget exits 4. */
  readonly print: boolean;
  /** `--secret NAME=value` pairs: this run only, never stored. */
  readonly secrets?: Readonly<Record<string, string>>;
  /** `--env NAME=value` pairs the workflow's `env:` pass-through may hand to steps. */
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * `taliqraph <workflow>`: run the workflow in the working folder with the
 * given inputs and print its feed until it ends. Gates are answered in this
 * terminal, or by themselves under `-p` (every item ticked, the default
 * choice, the fallback answer to a question). Secrets come from `--secret`,
 * then the environment; MCP servers from `--mcp-servers`. The prompt is
 * injectable for tests.
 */
export async function runCommand(
  workflow: string,
  inputs: Readonly<Record<string, unknown>>,
  options: RunOptions,
  out: Output,
  prompt?: GatePrompt,
): Promise<void> {
  const state = new FeedState();
  const controller = new AbortController();
  const onInterrupt = (): void => controller.abort();
  process.once('SIGINT', onInterrupt);
  const startedAt = Date.now();
  try {
    const result = await runWorkflow({
      workflow,
      inputs,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.print ? { headless: true } : { onGate: gateHandler(prompt, onInterrupt) }),
      engines: createDefaultEngines(),
      mcpServers: options.mcpServersFile
        ? await readMcpServersFile(options.mcpServersFile, options.cwd ?? process.cwd())
        : [],
      ...(options.secrets ? { secrets: options.secrets } : {}),
      ...(options.env ? { env: options.env } : {}),
      signal: controller.signal,
      onEvent: (event) => {
        printEvent(event, state, out, options);
      },
    });
    printOutcome(result, Date.now() - startedAt, out, options.outputFormat);
    process.exitCode = result.exitCode;
  } catch (cause) {
    out.error(cause instanceof Error ? cause.message : String(cause));
    process.exitCode =
      cause instanceof WorkflowInvalid || cause instanceof TaskInputError
        ? EXIT.problems
        : EXIT.error;
  } finally {
    process.off('SIGINT', onInterrupt);
  }
}

/** The terminal answers gates; without one (a pipe, a script) the first pause fails the run with a pointer to -p. */
function gateHandler(
  prompt: GatePrompt | undefined,
  interrupt: () => void,
): NonNullable<Parameters<typeof runWorkflow>[0]['onGate']> {
  const terminal =
    prompt ?? (process.stdin.isTTY && process.stdout.isTTY ? terminalPrompt() : undefined);
  if (terminal) {
    return terminalGate(terminal, interrupt);
  }
  return (gate) =>
    Promise.reject(
      new Error(
        `'${gate.stepId}' pauses the run and there is no terminal to answer it - run with -p to auto-answer`,
      ),
    );
}

function printEvent(
  event: TimedRunEvent,
  state: FeedState,
  out: Output,
  options: RunOptions,
): void {
  state.note(event);
  if (options.outputFormat === 'stream-json') {
    out.record(event);
  } else if (options.outputFormat === 'text') {
    const line = renderEvent(event, state, out, options.verbose ?? false);
    if (line) {
      out.line(line);
    }
  }
}

function printOutcome(
  result: RunResult,
  durationMs: number,
  out: Output,
  outputFormat: OutputFormat,
): void {
  if (outputFormat === 'json') {
    // the log is what the feed already printed; the rest is the result
    const { events, ...rest } = result;
    out.line(
      JSON.stringify(
        { ...rest, costUsd: result.metrics.costUsd, durationMs, eventCount: events.length },
        null,
        2,
      ),
    );
    return;
  }
  if (outputFormat === 'text') {
    out.line(
      [
        result.status,
        formatDuration(durationMs),
        formatCost(result.metrics.costUsd),
        result.summary ?? result.message ?? '',
      ]
        .filter(Boolean)
        .join(' '),
    );
    for (const line of outputLines(result.output)) {
      out.line(out.dim(line));
    }
  }
}

/** What the run handed back, one line per key: the values, not their names. */
export function outputLines(
  output: Readonly<Record<string, unknown>> | undefined,
  width = 100,
): string[] {
  const entries = Object.entries(output ?? {}).filter(([key]) => key !== '_summary');
  return entries.map(([key, value]) => {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    const shown = (text ?? 'null').replace(/\s+/g, ' ');
    return `  ${key}: ${shown.length > width ? `${shown.slice(0, width - 1)}\u2026` : shown}`;
  });
}
