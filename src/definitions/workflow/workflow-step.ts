import type { EffortLevel } from '../../shared/types/effort';

interface BaseStep {
  readonly id: string;
}

/** Loop-aware run policy: how often a step actually executes across passes. */
export interface RunPolicy {
  /** Skip the step once it has run this many times (1 = first pass only). */
  readonly maxRuns: number;
}

export interface AgentStep extends BaseStep {
  readonly kind: 'agent';
  readonly agent: string;
  readonly model?: string;
  readonly effort?: EffortLevel;
  readonly input: readonly string[];
  readonly output?: string;
  /** A reviewer-style agent can bounce the run back when its report says blocking: true. */
  readonly onBlocking?: OnBlockingPolicy;
  /** Declared workflow secrets this agent's session gets in its environment. */
  readonly secrets?: readonly string[];
  readonly when?: RunPolicy;
}

/** One exit button of a gate with choices. */
export interface GateChoice {
  readonly id: string;
  readonly label: string;
  /** 'selection' (default) disables the button until at least one item is ticked. */
  readonly needs: 'selection' | 'none';
  /** The exit a headless run takes; without one, the first choice. At most one per gate. */
  readonly default?: boolean;
}

/**
 * The user-input step: the run stops here and shows `show`. Four answers:
 * approve / send back (always), edit the shown text (`editable`), tick items
 * from a shown list (`select`), pick one of the author's `choices`. With
 * choices there is no "send back": routing on `<id>.choice` is a condition's job.
 */
/**
 * What a gate asks for: approve or deny what it shows, pick one of the
 * author's choices, or tick entries from a list a step produced.
 */
export type GateKind = 'approve' | 'choice' | 'select';

export interface GateStep extends BaseStep {
  readonly kind: 'gate';
  readonly gate: GateKind;
  readonly show: readonly string[];
  readonly editable: boolean;
  /** `gate: select` only: the reference whose array becomes the tickable entries. */
  readonly list?: string;
  /** The exits to pick from: required by `gate: choice`, optional on `gate: select`. */
  readonly choices?: readonly GateChoice[];
}

export interface SubWorkflowStep extends BaseStep {
  readonly kind: 'workflow';
  readonly workflow: string;
  readonly onBlocking?: OnBlockingPolicy;
  readonly when?: RunPolicy;
}

export interface OnBlockingPolicy {
  readonly gotoStepId: string;
  readonly maxLoops: number;
  readonly then: 'gate' | 'fail';
}

/**
 * A script: `command` is either the name of a script definition (an exact
 * match wins) or a shell command line run in the task workspace. Either way
 * the last JSON line it prints (or `$TQ_REPORT_FILE`) becomes its output.
 * `input` references are positional (they fill the definition's parameters
 * in order) and reach the script as `$TQ_INPUTS` (JSON: task, args, each
 * value by parameter name), the same JSON on stdin, and env (`TQ_ARG_<n>`,
 * `TQ_INPUT_<NAME>`). Outward operations (post a review, open a PR) are
 * scripts too; there is no other non-agent step kind.
 */
export interface ScriptStep extends BaseStep {
  readonly kind: 'script';
  readonly command: string;
  readonly input?: readonly string[];
  /**
   * Named parameters (`with:`), resolved before the run: a string of the form
   * `$<ref>` reads that output path, anything else is a literal. They reach
   * the script under their own key in `$TQ_INPUTS` and as `TQ_INPUT_<NAME>`.
   */
  readonly params?: Readonly<Record<string, unknown>>;
  readonly output?: string;
  /** Declared workflow secrets this script gets in its environment. */
  readonly secrets?: readonly string[];
  readonly when?: RunPolicy;
}

export type CompareOp = 'equals' | 'not_equals' | 'gte' | 'lte' | 'in' | 'truthy';

/** Structured comparison over a dotted path into collected outputs: no expression eval, ever. */
export interface Comparator {
  readonly op: CompareOp;
  readonly value?: unknown;
}

/**
 * A branch runs as its own ephemeral child run with its own step pointer, so a
 * condition/while inside it jumps only within that SAME branch. That makes
 * nesting safe to any depth the orchestrator allows. Still excluded:
 *   - GateStep: an approval pauses the WHOLE pipeline, which a concurrent
 *     branch cannot coherently do while its siblings are mid-flight. A
 *     condition's lane may hold one (see ConditionBranchStep) as long as that
 *     condition is not itself under a fork.
 *   - ForEachStep: for_each does not nest inside a branch.
 */
export type BranchStep =
  AgentStep | ScriptStep | SubWorkflowStep | ParallelStep | ConditionStep | WhileStep;

/** A parallel branch is a small sequential chain. Never empty: a concurrent
 *  branch that does nothing isn't a branch. */
export type Branch = readonly [BranchStep, ...BranchStep[]];

/**
 * Jump to another step: the one in this lane if it's there, else the
 * enclosing pipeline's. Counted per goto (the count survives the lane being
 * re-entered); once `maxLoops` jumps have been taken it falls through to the
 * next step instead; pair it with a `fail` step for "retry N times, then give up".
 */
export interface GotoStep extends BaseStep {
  readonly kind: 'goto';
  readonly targetStepId: string;
  readonly maxLoops: number;
}

/**
 * Ends the WHOLE run successfully right here; whatever follows is skipped.
 * What it is given (`input:` positional, `with:` named, `$ref` resolved) is the
 * run's output; nothing else is.
 */
export interface FinishStep extends BaseStep {
  readonly kind: 'finish';
  readonly input?: readonly string[];
  readonly params?: Readonly<Record<string, unknown>>;
}

/** Fails the WHOLE run with this message; its input/with is the structured failure output. */
export interface FailStep extends BaseStep {
  readonly kind: 'fail';
  readonly message: string;
  readonly input?: readonly string[];
  readonly params?: Readonly<Record<string, unknown>>;
}

/** Steps that steer or end the pipeline itself: a gate pauses it, the flow steps jump/finish/fail it. */
export type FlowStep = GotoStep | FinishStep | FailStep;

/**
 * What a condition's embedded lane may hold: everything a fork branch can,
 * plus the steps that steer the pipeline itself (a gate, or a goto/finish/
 * fail). Only one side of a condition ever runs, so pausing, jumping out of
 * or ending the run from there is coherent; the parser still refuses all of
 * them when the condition sits anywhere inside a fork (siblings mid-flight).
 */
export type ConditionBranchStep = BranchStep | GateStep | FlowStep;

/** Branch: jump to `then` when the comparison holds, `else` (or fall through) when it doesn't. */
export type ConditionBranch =
  | { readonly kind: 'goto'; readonly stepId: string }
  /** Unlike a parallel Branch, this MAY be empty - "if true, just continue"
   *  is an ordinary shape; an idle concurrent fork branch is not. */
  | { readonly kind: 'steps'; readonly steps: readonly ConditionBranchStep[] };

export interface ConditionStep extends BaseStep {
  readonly kind: 'condition';
  readonly path: string;
  readonly compare: Comparator;
  readonly then: ConditionBranch;
  readonly else?: ConditionBranch;
}

/** Loop: jump back to `goto` while the comparison holds, up to maxLoops times. */
export interface WhileStep extends BaseStep {
  readonly kind: 'while';
  readonly path: string;
  readonly compare: Comparator;
  readonly gotoStepId: string;
  readonly maxLoops: number;
}

/** What a fan-out does when a branch fails: kill the run, keep the survivors, or ask. */
export type ForkFailurePolicy = 'fail' | 'continue' | 'ask';

/** Fan-out: branches run concurrently; the step completes when all do. */
export interface ParallelStep extends BaseStep {
  readonly kind: 'parallel';
  readonly children: readonly Branch[];
  /** Default 'fail': one failed branch kills the run. */
  readonly onFail?: ForkFailurePolicy;
  /** Loop back when ANY branch's report says blocking: true. */
  readonly onBlocking?: OnBlockingPolicy;
}

/**
 * Dynamic fan-out: run the agent template once per item of the array at
 * `path`, concurrently. Each item is exposed to its agent under `itemName`;
 * results are namespaced '<id>.1' … '<id>.n'.
 */
export interface ForEachStep extends BaseStep {
  readonly kind: 'foreach';
  readonly path: string;
  readonly itemName: string;
  readonly maxItems: number;
  readonly template: AgentStep;
  /** Default 'fail': one failed item kills the run. */
  readonly onFail?: ForkFailurePolicy;
  /** Loop back when ANY item's report says blocking: true. */
  readonly onBlocking?: OnBlockingPolicy;
}

export type WorkflowStep =
  | AgentStep
  | GateStep
  | SubWorkflowStep
  | ScriptStep
  | ConditionStep
  | WhileStep
  | ParallelStep
  | ForEachStep
  | GotoStep
  | FinishStep
  | FailStep;

export type WorkflowStepKind = WorkflowStep['kind'];
