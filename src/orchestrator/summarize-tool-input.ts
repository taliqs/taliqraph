const DETAIL_KEYS = [
  'command',
  'file_path',
  'path',
  'pattern',
  'query',
  'url',
  'prompt',
  'description',
] as const;

const MAX_DETAIL_LENGTH = 140;

/**
 * Best-effort one-line description of a tool call from its input, using the
 * argument conventions coding engines share (command, file_path, pattern, …).
 */
export function summarizeToolInput(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null) {
    return undefined;
  }
  const record = input as Record<string, unknown>;
  for (const key of DETAIL_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      const flattened = value.replace(/\s+/g, ' ').trim();
      return flattened.length > MAX_DETAIL_LENGTH
        ? `${flattened.slice(0, MAX_DETAIL_LENGTH)}…`
        : flattened;
    }
  }
  return undefined;
}
