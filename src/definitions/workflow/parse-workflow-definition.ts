import type { Result } from '../../shared/types/result';
import { err, ok } from '../../shared/types/result';
import { errorMessage } from '../../shared/utils/error-message';
import { parse as parseYaml } from 'yaml';
import type { DefinitionParseError } from '../definition-parse-error';
import { definitionParseError } from '../definition-parse-error';
import { formatZodIssues } from '../format-zod-issues';
import type { DefinitionScope } from '../scope';
import { parseStep } from './parse-workflow-steps';
import { validateStepReferences } from './validate-step-references';
import type {
  WorkflowDefinition,
  WorkflowInput,
  WorkflowInputType,
  WorkflowSecret,
} from './workflow-definition';
import { inputSpecSchema, workflowFileSchema } from './workflow-schema';
import type { WorkflowStep } from './workflow-step';

/** Environment-variable shaped, so the name is what the step's process sees. */
export const SECRET_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/** An input name is an identifier: steps read it as `inputs.<name>`. */
export const INPUT_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

/**
 * The `inputs:` mapping as the builder edits it (JSON text of the same shape as
 * the YAML): each entry is a spec (`{ type: number, … }`) or a plain
 * example value whose JSON type stands for text / number / boolean. Returns the
 * declarations it means and what is wrong with it.
 */
export function parseInputsMapping(raw: unknown): {
  readonly inputs: WorkflowInput[];
  readonly issues: string[];
} {
  const issues: string[] = [];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { inputs: [], issues: ['inputs: a mapping of name → spec or example value'] };
  }
  const inputs = parseInputDeclarations(raw as Readonly<Record<string, unknown>>, issues);
  return { inputs, issues };
}

/** The type a plain example value stands for; a multi-line string means a prompt. */
function exampleValueType(value: string | number | boolean): WorkflowInputType {
  if (typeof value === 'number') {
    return 'number';
  }
  if (typeof value === 'boolean') {
    return 'boolean';
  }
  return value.includes('\n') ? 'prompt' : 'text';
}

function parseInputDeclarations(
  raw: Readonly<Record<string, unknown>>,
  issues: string[],
): WorkflowInput[] {
  const inputs: WorkflowInput[] = [];
  for (const [name, value] of Object.entries(raw)) {
    const at = `inputs.${name}`;
    if (!INPUT_NAME_PATTERN.test(name)) {
      issues.push(
        `${at}: an input is named like an identifier (prompt, pr, target_branch) - steps read it as inputs.${name}`,
      );
      continue;
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      // a plain example value is the default too, so it is optional; an empty string is a required text
      inputs.push({
        name,
        type: exampleValueType(value),
        required: value === '',
        ...(value !== '' ? { default: value } : {}),
      });
      continue;
    }
    const parsed = inputSpecSchema.safeParse(value);
    if (!parsed.success) {
      issues.push(
        `${at}: ${formatZodIssues(parsed.error).join('; ')} - an input is { type: text | prompt | number | boolean | choice, required?, description?, default?, options? } or a plain example value`,
      );
      continue;
    }
    const spec = parsed.data;
    if (spec.type === 'choice' && !spec.options) {
      issues.push(`${at}: a choice input needs options: [a, b, c]`);
      continue;
    }
    if (spec.type !== 'choice' && spec.options) {
      issues.push(`${at}: options: only belongs to a choice input`);
      continue;
    }
    inputs.push({
      name,
      type: spec.type,
      required: spec.required ?? spec.default === undefined,
      ...(spec.description ? { description: spec.description } : {}),
      ...(spec.default !== undefined ? { default: spec.default } : {}),
      ...(spec.options ? { options: spec.options } : {}),
    });
  }
  return inputs;
}

/** Any legal variable name - pass-through covers lowercase oddities too. */
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** `GH_TOKEN` / `JIRA_API_TOKEN?` → { name, required }; a bad name is an issue. */
function parseSecretDeclarations(raw: readonly string[], issues: string[]): WorkflowSecret[] {
  const seen = new Set<string>();
  const secrets: WorkflowSecret[] = [];
  raw.forEach((entry, index) => {
    const required = !entry.endsWith('?');
    const name = required ? entry : entry.slice(0, -1);
    if (!SECRET_NAME_PATTERN.test(name)) {
      issues.push(
        `secrets[${index}]: '${entry}' - a secret is named like an environment variable (GH_TOKEN, JIRA_API_TOKEN), with a trailing ? for optional`,
      );
      return;
    }
    if (seen.has(name)) {
      issues.push(`secrets[${index}]: '${name}' is declared twice`);
      return;
    }
    seen.add(name);
    secrets.push({ name, required });
  });
  return secrets;
}

export function parseWorkflowDefinition(
  source: string,
  scope: DefinitionScope,
): Result<WorkflowDefinition, DefinitionParseError> {
  let raw: unknown;
  try {
    raw = parseYaml(source);
  } catch (cause) {
    return err(definitionParseError(`Workflow file is not valid YAML: ${errorMessage(cause)}`));
  }

  const parsed = workflowFileSchema.safeParse(raw);
  if (!parsed.success) {
    return err(
      definitionParseError('Workflow definition is invalid', formatZodIssues(parsed.error)),
    );
  }

  const issues: string[] = [];
  const inputs = parseInputDeclarations(parsed.data.inputs, issues);
  const secrets = parseSecretDeclarations(parsed.data.secrets, issues);
  const declaredSecretNames = new Set(secrets.map((secret) => secret.name));
  const env = [...new Set(parsed.data.env)];
  env.forEach((name, index) => {
    if (!ENV_NAME_PATTERN.test(name)) {
      issues.push(`env[${index}]: '${name}' is not an environment variable name`);
    } else if (declaredSecretNames.has(name)) {
      issues.push(
        `env[${index}]: '${name}' is a declared secret - steps ask for it with secrets:, not env:`,
      );
    }
  });
  const steps: WorkflowStep[] = [];
  parsed.data.steps.forEach((rawStep, index) => {
    const step = parseStep(rawStep, index, issues);
    if (step) {
      steps.push(step);
    }
  });

  issues.push(...validateStepReferences(steps));

  if (issues.length > 0) {
    return err(definitionParseError('Workflow steps are invalid', issues));
  }

  return ok({
    name: parsed.data.name,
    title: parsed.data.title ?? parsed.data.name,
    ...(parsed.data.description ? { description: parsed.data.description } : {}),
    ...(parsed.data.extends ? { extendsName: parsed.data.extends } : {}),
    ...(inputs.length > 0 ? { inputs } : {}),
    ...(secrets.length > 0 ? { secrets } : {}),
    ...(env.length > 0 ? { env } : {}),
    steps,
    scope,
  });
}
