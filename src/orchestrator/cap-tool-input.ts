const MAX_STRING_LENGTH = 2_000;
const MAX_TOTAL_LENGTH = 16_000;
const MAX_ENTRIES = 50;
const MAX_DEPTH = 6;

/**
 * Tool inputs are persisted so the user can inspect exactly what a tool did -
 * but a Write call can carry a whole file. Long strings and huge structures
 * are truncated with visible markers; the shape stays inspectable.
 */
export function capToolInput(input: unknown): unknown {
  if (input === undefined) {
    return undefined;
  }
  const capped = deepCap(input, 0);
  let serialized: string;
  try {
    serialized = JSON.stringify(capped) ?? '';
  } catch {
    return undefined;
  }
  if (serialized.length <= MAX_TOTAL_LENGTH) {
    return capped;
  }
  return {
    note: 'input truncated for storage',
    preview: serialized.slice(0, MAX_TOTAL_LENGTH),
  };
}

function deepCap(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) {
    return '[nested too deep]';
  }
  if (typeof value === 'string') {
    return value.length > MAX_STRING_LENGTH
      ? `${value.slice(0, MAX_STRING_LENGTH)}… [+${value.length - MAX_STRING_LENGTH} chars]`
      : value;
  }
  if (Array.isArray(value)) {
    const capped = value.slice(0, MAX_ENTRIES).map((entry) => deepCap(entry, depth + 1));
    if (value.length > MAX_ENTRIES) {
      capped.push(`[+${value.length - MAX_ENTRIES} more entries]`);
    }
    return capped;
  }
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    let count = 0;
    for (const [key, entry] of Object.entries(value)) {
      if (count >= MAX_ENTRIES) {
        out['…'] = '[more keys omitted]';
        break;
      }
      out[key] = deepCap(entry, depth + 1);
      count += 1;
    }
    return out;
  }
  return value;
}
