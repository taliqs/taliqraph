import { readOutputPath } from './read-output-path';

export interface StepInputOptions {
  readonly workspacePath?: string;
  /** The workspace is an isolated copy made for this run, not the folder itself. */
  readonly isolated?: boolean;
  /**
   * References from the step's `input:` list - a step id or output alias,
   * optionally dotted into a field (`review.bug-hunt.findings`); `inputs.<name>`
   * is a declared input, `run.*` run state.
   */
  readonly inputNames: readonly string[];
  /** Everything resolvable: step outputs under id and alias, plus the synthetic `inputs` and `run` roots. */
  readonly outputs: Readonly<Record<string, unknown>>;
  readonly feedbackNote?: string;
}

export function buildStepInput(options: StepInputOptions): string {
  const sections: string[] = [];

  if (options.workspacePath) {
    sections.push(
      options.isolated
        ? `# Workspace\nYou are in an isolated working copy at ${options.workspacePath}. Work only inside it - never follow paths to other copies of this project.`
        : `# Workspace\nYou work in ${options.workspacePath}. Work only inside it.`,
    );
  }

  for (const name of expandAll(options.inputNames, options.outputs)) {
    sections.push(inputSection(name, readOutputPath(options.outputs, name)));
  }

  if (options.feedbackNote) {
    sections.push(
      `# Feedback on the previous attempt\n${options.feedbackNote}\nAddress this feedback and try again.`,
    );
  }

  return sections.join('\n\n');
}

function inputSection(name: string, value: unknown): string {
  if (value === undefined) {
    return `# ${name}\n(not available)`;
  }
  // a declared text input reads as prose, not as a quoted JSON string
  if (typeof value === 'string' && name.startsWith('inputs.')) {
    return `# ${name}\n${value}`;
  }
  return `# ${name}\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

/**
 * A script step's inputs as one plain object - what the runner hands over as
 * `$TQ_INPUTS`, stdin and environment variables. Positional, like arguments to
 * a function: `args` holds every reference's value in the order the step lists
 * them (null when nothing produced it); each value is also there under the
 * script's parameter name for that slot (`parameters`, from its manifest) or,
 * past the declared ones, under the reference itself; `task` is always the
 * brief. `all` expands as it does for agents.
 */
export function collectStepInputs(
  names: readonly string[],
  outputs: Readonly<Record<string, unknown>>,
  parameters: readonly string[] = [],
): Record<string, unknown> {
  const refs = expandAll(names, outputs);
  const args = refs.map((name) => readOutputPath(outputs, name) ?? null);
  // `inputs` = the workflow's declared inputs as one object, always there for scripts
  const collected: Record<string, unknown> = { inputs: outputs['inputs'] ?? {}, args };
  refs.forEach((name, index) => {
    const key = parameters[index] ?? name;
    if (key !== 'inputs' && key !== 'args') {
      collected[key] = args[index];
    }
  });
  return collected;
}

/**
 * `all` = every output produced so far, in the order it was produced, each
 * under its step id (an alias points at the same object - listed once).
 * Synthetic keys (`run`, for_each item slots) are not steps and stay out.
 */
function expandAll(names: readonly string[], outputs: Readonly<Record<string, unknown>>): string[] {
  if (!names.includes('all')) {
    return [...names];
  }
  const seen = new Set<unknown>();
  const everything = Object.entries(outputs)
    .filter(([key, value]) => {
      if (key === 'run' || key === 'inputs' || key.startsWith('__foreach:') || seen.has(value)) {
        return false;
      }
      seen.add(value);
      return true;
    })
    .map(([key]) => key);
  return names.flatMap((name) => (name === 'all' ? everything : [name]));
}
