import type { GateChoice } from '../definitions/workflow/workflow-step';
/** Synthetic gate id for the per-task cost cap. */
export const BUDGET_GATE_ID = '__budget__';

/** One tickable entry of a `gate: select`: a stable key, the reference it came from, the value itself. */
export interface GateItem {
  readonly key: string;
  readonly ref: string;
  readonly value: unknown;
}

/** What the user has done on an open gate's list so far - keys, not values (the items are on gate-opened). */
export interface GateSelection {
  readonly selected: readonly string[];
  readonly dismissed: readonly { readonly key: string; readonly reason: string }[];
  /** Edited text per shown reference, when the gate is editable. */
  readonly edited?: Readonly<Record<string, string>>;
  /** Carry item details when the selection is posted somewhere. */
  readonly includeDetails?: boolean;
}

/** The user's answer to a gate: approve/reject plus, when the gate asks for it, a choice and the final selection. */
export interface GateAnswer {
  readonly choice?: string;
  readonly selection?: Partial<GateSelection>;
}

/**
 * The event-sourcing vocabulary of a workflow run. Every state transition is
 * one of these; a host persists them and renders
 * them. Sub-workflow events surface with `parent/child` step ids.
 */
export type RunEvent =
  | {
      readonly type: 'run-started';
      readonly workflowName: string;
      /** The declared inputs the run was started with, resolved; secrets are never here. */
      readonly inputs?: Readonly<Record<string, unknown>>;
    }
  | {
      readonly type: 'step-started';
      readonly stepId: string;
      readonly stepKind: string;
      readonly attempt: number;
      /** What the step was handed, as it is written in the file: `inputs.question`, `review.findings`. */
      readonly input?: readonly string[];
      readonly agentName?: string;
      readonly model?: string;
      readonly effort?: string;
    }
  | { readonly type: 'agent-text'; readonly stepId: string; readonly text: string }
  /** Live typing fragment - broadcast to the UI, never persisted; the full text follows as agent-text. */
  | { readonly type: 'agent-text-partial'; readonly stepId: string; readonly text: string }
  | {
      readonly type: 'agent-tool-call';
      readonly stepId: string;
      readonly callId: string;
      readonly toolName: string;
      /** One-line human-readable description, e.g. the command or file path. */
      readonly detail?: string;
      /** Full tool input (size-capped) - the "extend" view in the feed. */
      readonly input?: unknown;
    }
  | {
      readonly type: 'agent-tool-result';
      readonly stepId: string;
      readonly callId: string;
      readonly isError: boolean;
    }
  | {
      readonly type: 'step-usage';
      readonly stepId: string;
      readonly tokensIn: number;
      readonly tokensOut: number;
      readonly costUsd?: number;
    }
  | { readonly type: 'step-summary'; readonly stepId: string; readonly text: string }
  | {
      readonly type: 'step-completed';
      readonly stepId: string;
      readonly report?: unknown;
      /** Soft contract warnings - declared report fields the reply lacked. */
      readonly reportIssues?: readonly string[];
    }
  | {
      readonly type: 'step-failed';
      readonly stepId: string;
      readonly message: string;
      readonly attempt: number;
    }
  /** Run policy (when.max_runs) decided this step doesn't execute on this pass. */
  | { readonly type: 'step-skipped'; readonly stepId: string; readonly reason: string }
  | {
      readonly type: 'gate-opened';
      readonly stepId: string;
      readonly show: readonly string[];
      /** The `show` references resolved at the moment the gate opened ('diff' excluded - the UI fetches it live). */
      readonly shown?: Readonly<Record<string, unknown>>;
      /** An agent's mid-run prompt: the question or permission ask shown on the card. */
      readonly question?: string;
      readonly promptKind?: 'question' | 'permission';
      /** Suggested answers (first = the agent's recommendation); free text always allowed. */
      readonly options?: readonly string[];
      /** `gate: select`: the entries as they were when it opened. */
      readonly list?: { readonly ref: string; readonly items: readonly GateItem[] };
      /** The author's exit buttons; absent = Approve / Request changes. */
      readonly choices?: readonly GateChoice[];
      readonly editable?: boolean;
    }
  /** Ticks, dismissals and edits on an open gate - the full state each time, so a restart shows the same list. */
  | {
      readonly type: 'gate-selection-changed';
      readonly stepId: string;
      readonly selection: GateSelection;
    }
  | {
      readonly type: 'gate-resolved';
      readonly stepId: string;
      readonly approved: boolean;
      /** Absent = a person answered; 'headless' = the run approved itself. */
      readonly by?: 'headless';
      readonly note?: string;
      /** The picked choice id, on a gate with choices. */
      readonly choice?: string;
      /** The selection as it was when the gate closed (entry keys), on a `gate: select`. */
      readonly selection?: GateSelection;
    }
  | {
      readonly type: 'loop-back';
      readonly fromStepId: string;
      readonly toStepId: string;
      readonly iteration: number;
      readonly reason: 'blocking-review' | 'gate-rejected' | 'while' | 'goto';
      readonly note?: string;
    }
  /**
   * The run's result: what its finish step was given - author-chosen
   * key/values plus `_summary` - under `output`; `outputs` keeps every step's
   * report by id for the feed and for scripts that read the whole run.
   */
  | {
      readonly type: 'run-completed';
      readonly output: Readonly<Record<string, unknown>>;
      readonly outputs?: Readonly<Record<string, unknown>>;
    }
  /** `cause: budget` = a headless run hit its cap - the CLI exits 4 for it. `output` = a fail step's structured result. */
  | {
      readonly type: 'run-failed';
      readonly message: string;
      readonly cause?: 'budget';
      readonly output?: Readonly<Record<string, unknown>>;
    }
  | { readonly type: 'run-cancelled' }
  | {
      readonly type: 'condition-evaluated';
      readonly stepId: string;
      readonly path: string;
      readonly value?: unknown;
      readonly result: boolean;
      /** Where the run jumped; absent = fell through to the next step. */
      readonly to?: string;
      /** A while step's check (result = looped again) rather than an if. */
      readonly loop?: boolean;
    }
  /** The run stopped without failing: a crash (appended at boot for tasks left mid-run), a usage limit, or an expired login. */
  | {
      readonly type: 'run-interrupted';
      readonly reason: string;
      /** 'quota' = a usage/rate limit (skip the retry, resume later); absent/'crash' = the host went away mid-run. */
      readonly cause?: 'crash' | 'quota' | 'auth';
      /** ISO timestamp the limit is expected to lift, when the engine named one. */
      readonly retryAt?: string;
    }
  /** A user hook command ran after a step or run. */
  | {
      readonly type: 'hook-ran';
      readonly hook: 'after_step' | 'after_task';
      readonly command: string;
      readonly exitCode: number;
      readonly output?: string;
    }
  | { readonly type: 'run-resumed' };

export type RunStatus = 'idle' | 'running' | 'waiting-gate' | 'completed' | 'failed' | 'cancelled';

export function isTerminal(status: RunStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}
