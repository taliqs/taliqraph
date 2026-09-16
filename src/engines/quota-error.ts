import { describeAuthFailure, isAuthFailure } from './auth-error';
import type { EngineEvent } from './engine-event';

export interface QuotaSignal {
  /** True when the message looks like a usage/rate limit, not a real bug. */
  readonly isQuota: boolean;
  /** The message to show the user - decoded/cleaned up when possible. */
  readonly message: string;
  /** ISO timestamp the limit is expected to lift, when the message names one. */
  readonly retryAt?: string;
}

/**
 * Claude Code CLI's usage-cap message: "Claude AI usage limit reached|<epoch>".
 * The engine adapters run the CLI as a subprocess, so this string (rather
 * than a typed API error) is what actually reaches us.
 */
const CLAUDE_USAGE_LIMIT = /claude ai usage limit reached\|(\d+)/i;

/** Anthropic API 429s and Claude Code's own rate/usage wording. */
const QUOTA_PATTERNS = [
  /rate_limit_error/i,
  /rate limit/i,
  /usage limit/i,
  /quota exceeded/i,
  /\b429\b/i,
  /overloaded_error/i,
  /you.?ve hit your usage limit/i,
];

/** "try again in 42 seconds" / "retry after 3 minutes" style hints. */
const RETRY_AFTER = /(?:try again|retry)(?:\s+\w+)?\s+in\s+(\d+)\s*(second|minute|hour)s?/i;

/**
 * Heuristic classification of an engine error message as a quota/rate-limit
 * condition (not the workflow's fault, resolves itself) vs. a real failure.
 * The Claude Agent SDK (a CLI subprocess) does not expose a
 * typed error with a machine-readable retry time, so this is pattern
 * matching on the human-readable text engines actually produce.
 */
export function detectQuotaSignal(rawMessage: string): QuotaSignal {
  const claudeUsage = rawMessage.match(CLAUDE_USAGE_LIMIT);
  if (claudeUsage?.[1]) {
    const resetAt = new Date(Number(claudeUsage[1]) * 1000);
    return {
      isQuota: true,
      message: `Claude AI usage limit reached - resets ${resetAt.toLocaleString()}`,
      retryAt: resetAt.toISOString(),
    };
  }

  const isQuota = QUOTA_PATTERNS.some((pattern) => pattern.test(rawMessage));
  if (!isQuota) {
    return { isQuota: false, message: rawMessage };
  }

  const retryAfter = rawMessage.match(RETRY_AFTER);
  if (retryAfter?.[1] && retryAfter[2]) {
    const amount = Number(retryAfter[1]);
    return {
      isQuota: true,
      message: rawMessage,
      retryAt: new Date(Date.now() + amount * unitMilliseconds(retryAfter[2])).toISOString(),
    };
  }

  return { isQuota: true, message: rawMessage };
}

function unitMilliseconds(unit: string): number {
  switch (unit.toLowerCase()) {
    case 'hour':
      return 3_600_000;
    case 'minute':
      return 60_000;
    default:
      return 1_000;
  }
}

/** Builds the EngineEvent for an error message, classifying it along the way. */
export function errorEventOf(rawMessage: string): EngineEvent {
  if (isAuthFailure(rawMessage)) {
    return { type: 'error', message: describeAuthFailure(rawMessage), isAuthError: true };
  }
  const signal = detectQuotaSignal(rawMessage);
  return {
    type: 'error',
    message: signal.message,
    ...(signal.isQuota
      ? { isQuotaError: true, ...(signal.retryAt ? { retryAt: signal.retryAt } : {}) }
      : {}),
  };
}
