import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The inputs a task starts with, from the command line: `--input
 * name=value` pairs (repeatable) and/or `--inputs <json | file.json>`. Pairs
 * win over the file. Values stay text - the runtime types them per declaration.
 */
export function parseTaskInputs(
  pairs: readonly string[],
  inputsArg: string | undefined,
  cwd: string,
): Record<string, unknown> {
  const inputs: Record<string, unknown> = {};
  if (inputsArg) {
    const text = inputsArg.trim().startsWith('{')
      ? inputsArg
      : readFileSync(resolve(cwd, inputsArg), 'utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (cause) {
      throw new Error(
        `--inputs is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('--inputs must be a JSON object: { "name": value, … }');
    }
    Object.assign(inputs, parsed as Record<string, unknown>);
  }
  for (const pair of pairs) {
    const at = pair.indexOf('=');
    if (at <= 0) {
      throw new Error(`--input takes name=value, got '${pair}'`);
    }
    inputs[pair.slice(0, at).trim()] = pair.slice(at + 1);
  }
  return inputs;
}
