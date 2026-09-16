/**
 * The engines run as CLI subprocesses, so an expired login does not arrive as
 * a typed error: Claude Code answers the prompt with a one-line assistant
 * message ("Failed to authenticate: OAuth session expired and could not be
 * refreshed") and a zero-token result. Treating that as the agent's reply
 * produces a misleading "no JSON report" failure and a pointless retry -
 * recognise it and stop the run so the user can sign in and resume.
 */
const AUTH_PATTERNS = [
  /^failed to authenticate\b/i,
  /^authentication (failed|error)\b/i,
  /^not logged in\b/i,
  /^(please )?(run|use) `?\/login`?/i,
  /^invalid api key\b/i,
  /^oauth (session|token) (has )?(expired|is invalid)/i,
  /\bauthentication_error\b/,
];

/** Only a short, whole message counts - an agent describing an auth bug in prose must not trip this. */
const MAX_AUTH_MESSAGE_LENGTH = 300;

export function isAuthFailure(text: string): boolean {
  const trimmed = text.trim();
  return (
    trimmed.length > 0 &&
    trimmed.length <= MAX_AUTH_MESSAGE_LENGTH &&
    AUTH_PATTERNS.some((pattern) => pattern.test(trimmed))
  );
}

/** The user-facing wording: what happened, and the two ways to fix it. */
export function describeAuthFailure(raw: string): string {
  return `${raw.trim().replace(/[.\s]+$/, '')} - sign in again (\`taliqraph login\`, or wherever your host signs engines in), then resume the run.`;
}
