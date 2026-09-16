import type {
  WorkflowDefinition,
  WorkflowInput,
} from '../definitions/workflow/workflow-definition';

export interface ResolvedTaskInputs {
  /** Name → value, coerced by the declared type. */
  readonly values: Readonly<Record<string, unknown>>;
  /** The task's title: the first prompt/text input's first line, else the workflow title. */
  readonly title: string;
}

export class TaskInputError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(problems.join('; '));
    this.name = 'TaskInputError';
  }
}

/**
 * Resolves what the host collected against the workflow's
 * declaration: every required input present, every value of the declared
 * type. Runs before anything starts, so a bad form never becomes a run.
 */
export function resolveTaskInputs(
  workflow: Pick<WorkflowDefinition, 'title' | 'inputs'>,
  raw: Readonly<Record<string, unknown>>,
): ResolvedTaskInputs {
  const declared = workflow.inputs ?? [];
  const problems: string[] = [];
  const values: Record<string, unknown> = {};
  let firstText: string | undefined;

  for (const name of Object.keys(raw)) {
    if (!declared.some((input) => input.name === name)) {
      problems.push(`'${name}' is not an input of this workflow`);
    }
  }
  for (const input of declared) {
    const given = raw[input.name];
    const empty =
      given === undefined || given === null || (typeof given === 'string' && given.trim() === '');
    if (empty) {
      if (input.default !== undefined) {
        values[input.name] = input.default;
      } else if (input.required) {
        problems.push(
          `'${input.name}' is required${input.description ? ` - ${input.description}` : ''}`,
        );
      }
      continue;
    }
    try {
      const value = coerce(input, given);
      values[input.name] = value;
      if ((input.type === 'text' || input.type === 'prompt') && firstText === undefined) {
        firstText = String(value);
      }
    } catch (cause) {
      problems.push(`'${input.name}': ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }
  if (problems.length > 0) {
    throw new TaskInputError(problems);
  }
  const headline = firstText?.split('\n')[0]?.trim();
  const title = headline && headline.length > 0 ? headline.slice(0, 80) : workflow.title;
  return { values, title };
}

function coerce(input: WorkflowInput, given: unknown): unknown {
  switch (input.type) {
    case 'text':
    case 'prompt':
      return String(given).trim();
    case 'number': {
      const value = typeof given === 'number' ? given : Number(String(given).trim());
      if (!Number.isFinite(value)) {
        throw new Error(`'${String(given)}' is not a number`);
      }
      return value;
    }
    case 'boolean': {
      if (typeof given === 'boolean') return given;
      const text = String(given).trim().toLowerCase();
      if (['true', 'yes', 'on', '1'].includes(text)) return true;
      if (['false', 'no', 'off', '0'].includes(text)) return false;
      throw new Error(`'${String(given)}' is not true or false`);
    }
    case 'choice': {
      const value = String(given).trim();
      if (!input.options?.includes(value)) {
        throw new Error(`'${value}' is not one of ${(input.options ?? []).join(', ')}`);
      }
      return value;
    }
  }
}
