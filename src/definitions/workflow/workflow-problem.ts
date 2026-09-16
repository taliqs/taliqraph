/**
 * What the workflow linter reports. Stable codes so every consumer (the
 * host's problem list, a run refusing to start, a
 * CLI `lint` command) can render or filter the same way.
 */
export type ProblemSeverity = 'error' | 'warning' | 'info';

export type ProblemCode =
  /** A reference's root is produced by no step (and isn't task/all/diff/run). */
  | 'ref/unknown-producer'
  /** A reference to a later step that no jump ever brings the pipeline back from: it can never be there. */
  | 'ref/unreachable-later'
  /** A reference to a later step a loop does bring back: real from the second pass on, "(not available)" before. */
  | 'ref/later-pass'
  /** A reference to something written on one side of a condition only. */
  | 'ref/conditional'
  /** The producer's report skeleton declares fields, and this isn't one of them. */
  | 'ref/not-in-skeleton'
  /** A `run.*` path the linter doesn't know. */
  | 'ref/unknown-run-field'
  /** A gate's `select` is neither one of its `show` references nor a plain field name. */
  | 'gate/list-not-a-list'
  /** Two choices share an id. */
  | 'gate/duplicate-choice'
  /** A condition compares `<gate>.choice` against an id the gate does not offer. */
  | 'gate/unknown-choice'
  /** A jump (then/else/go to/while/on_blocking) names a step that doesn't exist where it may target. */
  | 'jump/unknown-target'
  /** A loop-back that points at the step itself or a later one. */
  | 'jump/not-backwards'
  /** A loop-back into a step that only runs once (when.max_runs). */
  | 'jump/into-run-once'
  | 'agent/unknown'
  /** An agent step's agent lists an MCP server that is not configured on this machine. */
  | 'mcp/unconfigured'
  /** The step names something that lives outside this workflow's package; it would be missing anywhere the package is copied. */
  | 'package/outside'
  | 'workflow/unknown'
  | 'workflow/self-nesting'
  /** An `output:` alias equal to another step's id; the two would overwrite each other. */
  | 'output/alias-collision'
  /** Steps after an unconditional finish/fail that nothing jumps to: they never run. */
  | 'flow/dead-steps'
  /** on_blocking on a single-step fork branch: nothing earlier in the branch to loop back to. */
  | 'fork/on-blocking-ignored'
  /** `script:` looks like a definition name but no script definition has it; it runs as a shell command. */
  | 'script/unknown'
  /** The step binds fewer inputs than the script's required parameters (inputs are positional). */
  | 'script/missing-input'
  /** The step binds more inputs than the script declares; the extra ones only arrive in `$TQ_INPUTS.args`. */
  | 'script/extra-input'
  /** `task`, the removed brief; declare an input and read inputs.<name>. */
  | 'ref/retired-task'
  /** `inputs.<name>` for a name the workflow does not declare. */
  | 'ref/unknown-input'
  /** A declared input no step reads. */
  | 'input/unused'
  /** A step lists a secret the workflow's `secrets:` does not declare. */
  | 'secret/undeclared'
  /** A declared secret no step lists; it would be resolved for nothing. */
  | 'secret/unused';

export interface ProblemLocation {
  /** The top-level pipeline step this belongs to. */
  readonly stepId: string;
  /** When the problem sits on a step inside a lane (fork branch / condition side): that step's own id. */
  readonly innerStepId?: string;
  /** Address into the definition object, e.g. ['steps', 2, 'then', 'steps', 0, 'input', 1]. */
  readonly address: readonly (string | number)[];
  /** The field on that step the problem is about: 'input' | 'show' | 'path' | 'agent' | 'workflow' | 'output' | 'then' | 'else' | 'goto' | 'on_blocking' … */
  readonly field?: string;
  /** The reference text, when the problem is about one. */
  readonly ref?: string;
}

export interface WorkflowProblem {
  readonly code: ProblemCode;
  readonly severity: ProblemSeverity;
  /** One sentence, self-contained; reads correctly with no other context. */
  readonly message: string;
  readonly where: ProblemLocation;
  /** A suggested fix, when there is an obvious one ("did you mean plan?"). */
  readonly hint?: string;
  /** Other steps involved, e.g. the loop that makes a later reference real. */
  readonly related?: readonly { readonly stepId: string; readonly note?: string }[];
}

export interface WorkflowLintResult {
  /** No errors (warnings and infos may remain). */
  readonly ok: boolean;
  readonly counts: { readonly error: number; readonly warning: number; readonly info: number };
  readonly problems: readonly WorkflowProblem[];
}
