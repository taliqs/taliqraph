/**
 * Dotted-path lookup into the collected outputs - the one reference grammar
 * agent inputs, gate `show`, script inputs and condition/while paths share:
 * `<step id or output alias>.<key>.<key>`, array indexes as numbers, and
 * `length` on arrays and strings. Undefined when any hop is missing.
 */
export function readOutputPath(outputs: Readonly<Record<string, unknown>>, path: string): unknown {
  let value: unknown = outputs;
  for (const key of path.split('.')) {
    if (key === 'length' && typeof value === 'string') {
      value = value.length;
      continue;
    }
    if (typeof value !== 'object' || value === null) {
      return undefined;
    }
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}
