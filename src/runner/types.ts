import type { GateChoice } from '../definitions/workflow/workflow-step';
import type { WorkflowProblem } from '../definitions/workflow/workflow-problem';
import type { EngineRegistry } from '../engines/engine-registry';
import type { McpServerSpec } from '../engines/engine-adapter';
import type { GateItem, GateSelection, RunEvent } from '../orchestrator/run-event';

/** A run event with the moment it happened, ISO 8601. */
export type TimedRunEvent = RunEvent & { readonly at: string };

export interface HooksConfig {
  /** Runs in the workspace after every completed top-level step (formatters, linters). */
  readonly afterStep?: string;
  /** Runs in the workspace when the run completes. */
  readonly afterTask?: string;
}

export interface RunWorkflowOptions {
  /** A package folder or a bundle file. */
  readonly workflow: string;
  readonly inputs?: Readonly<Record<string, unknown>>;
  /** Values for the secrets the workflow declares; the process environment is the fallback. */
  readonly secrets?: Readonly<Record<string, string | undefined>>;
  /** Host variables offered to the workflow's `env:` pass-through; the process environment is the fallback. */
  readonly env?: Readonly<Record<string, string>>;
  /** The folder the run works in: where agents edit, scripts run and hooks execute. Default: the process cwd. A host that wants isolation prepares the folder (a copy, a git worktree) and passes it here. */
  readonly cwd?: string;
  /** True when `cwd` is a copy the host made for this run: agents are told to stay inside it. */
  readonly isolated?: boolean;
  /** Shell commands to run in the workspace after each top-level step and after the run. */
  readonly hooks?: HooksConfig;
  /** Default: the Claude Code and Codex engines. */
  readonly engines?: EngineRegistry;
  /** Resolved MCP servers the agents may name; default none. */
  readonly mcpServers?: readonly McpServerSpec[];
  readonly onEvent?: (event: TimedRunEvent) => void;
  /** Answers every pause of the run; not consulted when `headless` is set. */
  readonly onGate?: (gate: GateRequest) => Promise<GateDecision>;
  /** Auto-answer every pause the way `-p` does. Required, or `onGate`, when the workflow can pause. */
  readonly headless?: boolean;
  /** Aborting cancels the run. */
  readonly signal?: AbortSignal;
  /** The events of an earlier run of the same workflow to continue from. */
  readonly resumeFrom?: readonly RunEvent[];
}

/** One pause of the run, as the host sees it. */
export interface GateRequest {
  readonly stepId: string;
  /** What the gate asks for: a yes/no, one of the author's exits, ticks on a list, an agent's question, a permission. */
  readonly kind: 'approve' | 'choice' | 'select' | 'question' | 'permission';
  readonly show: readonly string[];
  /** The `show` references as they were when the gate opened ('diff' excluded). */
  readonly shown?: Readonly<Record<string, unknown>>;
  readonly question?: string;
  /** Suggested answers to a question, the agent's recommendation first. */
  readonly suggestions?: readonly string[];
  readonly items?: readonly GateItem[];
  readonly choices?: readonly GateChoice[];
  readonly editable?: boolean;
  /** The ticks the gate opened with. */
  readonly selection?: GateSelection;
}

/** The host's answer: approve or send back, plus whatever the gate's kind asks for. */
export interface GateDecision {
  readonly approved: boolean;
  /** Feedback on a send-back, or the answer to a question (`answer` wins when both are given). */
  readonly note?: string;
  readonly answer?: string;
  /** The exit taken, on a gate with choices. */
  readonly choice?: string;
  /** Item keys, on a gate with a list. */
  readonly selected?: readonly string[];
  readonly dismissed?: readonly { readonly key: string; readonly reason: string }[];
  /** Edited text per shown reference, on an editable gate. */
  readonly edited?: Readonly<Record<string, string>>;
}

export interface TokenCounts {
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly total: number;
}

export interface StepMetrics {
  readonly id: string;
  readonly kind: string;
  readonly status: 'done' | 'failed' | 'skipped';
  readonly durationMs: number;
  readonly costUsd: number;
  readonly tokens: TokenCounts;
  readonly toolCalls: number;
  readonly engine?: string;
  readonly model?: string;
}

export interface RunMetrics {
  readonly costUsd: number;
  readonly tokens: TokenCounts;
  readonly durationMs: number;
  readonly steps: readonly StepMetrics[];
}

export interface RunResult {
  readonly status: 'done' | 'failed' | 'cancelled';
  /** What the run's finish or fail step handed out, `_summary` included. */
  readonly output?: Readonly<Record<string, unknown>>;
  readonly summary?: string;
  /** Why the run failed or stopped. */
  readonly message?: string;
  /** The folder the agents worked in: `cwd`. */
  readonly workspace: string;
  readonly metrics: RunMetrics;
  /** The whole log, the events resumed from included; feed it to `resumeFrom` to continue. */
  readonly events: readonly TimedRunEvent[];
  /** 0 done, 1 failed, 4 over budget, 130 cancelled. */
  readonly exitCode: number;
}

/** The linter refuses the workflow; nothing ran. */
export class WorkflowInvalid extends Error {
  constructor(
    readonly workflowName: string,
    readonly problems: readonly WorkflowProblem[],
  ) {
    super(describeProblems(workflowName, problems));
    this.name = 'WorkflowInvalid';
  }
}

/** The workflow can pause and nothing would answer; nothing ran. */
export class GateHandlerRequired extends Error {
  constructor(readonly stepIds: readonly string[]) {
    super(
      `This workflow pauses at ${stepIds.map((id) => `'${id}'`).join(', ')} - pass onGate to answer, or headless to auto-answer`,
    );
    this.name = 'GateHandlerRequired';
  }
}

/** Required secrets found neither in the options nor in the environment; nothing ran. */
export class SecretsMissing extends Error {
  constructor(
    readonly workflowName: string,
    readonly names: readonly string[],
  ) {
    super(
      `${workflowName} needs ${names.length === 1 ? 'the secret' : 'secrets'} ${names.join(', ')} - pass ${names.length === 1 ? 'it' : 'them'} in secrets or export ${names.length === 1 ? 'it' : 'them'} in the environment`,
    );
    this.name = 'SecretsMissing';
  }
}

/** Every error, one line each, located to its step. */
function describeProblems(workflowName: string, problems: readonly WorkflowProblem[]): string {
  const lines = problems.map((problem) => {
    const step = problem.where.innerStepId
      ? `${problem.where.stepId} > ${problem.where.innerStepId}`
      : problem.where.stepId;
    return `  ${step}: ${problem.message}${problem.hint ? ` (${problem.hint})` : ''}`;
  });
  return [
    `Workflow '${workflowName}' can't run - ${problems.length} error${problems.length === 1 ? '' : 's'}:`,
    ...lines,
  ].join('\n');
}
