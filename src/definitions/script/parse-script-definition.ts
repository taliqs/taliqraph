import type { Result } from '../../shared/types/result';
import { err, ok } from '../../shared/types/result';
import { errorMessage } from '../../shared/utils/error-message';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { DefinitionParseError } from '../definition-parse-error';
import { definitionParseError } from '../definition-parse-error';
import { formatZodIssues } from '../format-zod-issues';
import type { DefinitionScope } from '../scope';
import type { ScriptDefinition, ScriptInput } from './script-definition';
import { DEFAULT_SCRIPT_TIMEOUT_MINUTES } from './script-definition';

export const SCRIPT_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

const inputSchema = z.union([
  z.string().min(1),
  z.object({
    name: z.string().min(1),
    required: z.boolean().optional(),
    description: z.string().optional(),
  }),
]);

const manifestSchema = z.object({
  name: z
    .string()
    .regex(SCRIPT_NAME_PATTERN, 'lowercase letters, digits and dashes, starting with a letter'),
  title: z.string().min(1).optional(),
  description: z.string().min(1),
  run: z.string().min(1),
  inputs: z.array(inputSchema).default([]),
  /** The report skeleton as a YAML mapping, stored as JSON text like an agent's. */
  report: z.record(z.string(), z.unknown()).optional(),
  timeout_minutes: z
    .number()
    .int()
    .positive()
    .max(24 * 60)
    .optional(),
});

/** Parses one `script.yaml`. `dir` is the folder it came from; the runner resolves `run` against it. */
export function parseScriptDefinition(
  source: string,
  scope: DefinitionScope,
  options: { readonly dir?: string } = {},
): Result<ScriptDefinition, DefinitionParseError> {
  let raw: unknown;
  try {
    raw = parseYaml(source);
  } catch (cause) {
    return err(definitionParseError(`script.yaml is not valid YAML: ${errorMessage(cause)}`));
  }
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) {
    return err(definitionParseError('script.yaml is invalid', formatZodIssues(parsed.error)));
  }
  const data = parsed.data;
  const inputs: ScriptInput[] = data.inputs.map((entry) =>
    typeof entry === 'string'
      ? { name: entry, required: true }
      : {
          name: entry.name,
          required: entry.required ?? true,
          ...(entry.description ? { description: entry.description } : {}),
        },
  );
  return ok({
    name: data.name,
    ...(data.title ? { title: data.title } : {}),
    description: data.description,
    run: data.run,
    inputs,
    ...(data.report ? { reportExample: JSON.stringify(data.report, null, 2) } : {}),
    timeoutMinutes: data.timeout_minutes ?? DEFAULT_SCRIPT_TIMEOUT_MINUTES,
    scope,
    ...(options.dir ? { dir: options.dir } : {}),
  });
}
