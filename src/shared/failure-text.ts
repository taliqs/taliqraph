/**
 * What a failed step says, in one line: the headline, then the error the
 * command itself reported. Stack frames and source carets are noise at a
 * glance, so they are dropped here; the whole message stays on the event for
 * hosts that offer to show it.
 */
export function shortFailure(message: string): {
  readonly text: string;
  readonly hasMore: boolean;
} {
  const lines = message
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('at ') && !/^\^+$/.test(line));
  const headline = (lines[0] ?? message).replace(/:$/, '');
  const rest = lines.slice(1);
  const error = rest.find((line) => /^[A-Za-z]*(Error|Exception)\b/.test(line)) ?? rest[0];
  return {
    text: error ? `${headline}: ${error}` : headline,
    hasMore: message.split('\n').length > (error ? 2 : 1),
  };
}
