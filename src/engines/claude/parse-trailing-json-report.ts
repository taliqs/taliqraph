const JSON_FENCE_PATTERN = /```json\s*([\s\S]*?)```/g;

/** Agents end with a fenced JSON report; returns the last one, parsed, if present and valid. */
export function parseTrailingJsonReport(text: string): unknown {
  const fences = [...text.matchAll(JSON_FENCE_PATTERN)];
  const lastFence = fences.at(-1)?.[1];
  if (!lastFence) {
    return undefined;
  }
  try {
    return JSON.parse(lastFence);
  } catch {
    return undefined;
  }
}
