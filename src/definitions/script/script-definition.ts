import type { DefinitionScope } from '../scope';

/**
 * One parameter a script declares. Inputs are positional, like arguments to a
 * function: the workflow step's `input:` list fills the parameters in order,
 * and the script reads each by this name (`TQ_INPUT_<NAME>`, `$TQ_INPUTS.<name>`)
 * or by position (`TQ_ARG_<n>`, `$TQ_INPUTS.args[n-1]`).
 */
export interface ScriptInput {
  readonly name: string;
  /** The linter errors when the step binds fewer inputs than the required ones; the runner still runs (the script sees null). */
  readonly required: boolean;
  readonly description?: string;
}

/**
 * A script definition: a folder with `script.yaml` next to the code it runs.
 * A workflow references it as `script: <name>` (an exact match wins over a
 * shell command). The runner spawns `run` WITHOUT a shell (relative paths in
 * it resolve against the folder), with cwd = the task workspace, hands the
 * step's inputs over three ways (the JSON file at `$TQ_INPUTS`, the same JSON
 * on stdin, and env: `TQ_ARG_<n>` by position, `TQ_INPUT_<NAME>` by parameter
 * name) and reads the report from the last JSON line on stdout or from
 * `$TQ_REPORT_FILE` (which wins when written). `TQ_WORKSPACE` and
 * `TQ_SCRIPT_DIR` are set too.
 */
export interface ScriptDefinition {
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  /** The command line, e.g. `node run.mjs` or `python3 main.py --fast`. */
  readonly run: string;
  readonly inputs: readonly ScriptInput[];
  /**
   * JSON skeleton of the report the script ends with, the same role as an
   * agent's reportExample: the builder types `<step>.<field>` from it and the
   * linter checks references against it.
   */
  readonly reportExample?: string;
  readonly timeoutMinutes: number;
  readonly scope: DefinitionScope;
  /** Absolute folder holding script.yaml and the code; absent for embedded sources. */
  readonly dir?: string;
}

export const DEFAULT_SCRIPT_TIMEOUT_MINUTES = 10;
