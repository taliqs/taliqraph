import { describe, expect, it } from 'vitest';
import { detectQuotaSignal } from './quota-error';

describe('detectQuotaSignal', () => {
  it('decodes the Claude Code CLI usage-limit format with its epoch reset time', () => {
    const resetAt = Math.floor(Date.now() / 1000) + 3600;
    const result = detectQuotaSignal(`Claude AI usage limit reached|${resetAt}`);
    expect(result.isQuota).toBe(true);
    expect(result.message).toContain('usage limit reached');
    expect(result.retryAt).toBe(new Date(resetAt * 1000).toISOString());
  });

  it('flags a generic Anthropic rate_limit_error as quota', () => {
    const result = detectQuotaSignal(
      '429 {"type":"error","error":{"type":"rate_limit_error","message":"rate limited"}}',
    );
    expect(result.isQuota).toBe(true);
  });

  it('flags Codex-style usage limit wording', () => {
    expect(detectQuotaSignal("You've hit your usage limit. Try again later.").isQuota).toBe(true);
  });

  it('parses a relative retry hint into an ISO timestamp', () => {
    const before = Date.now();
    const result = detectQuotaSignal('Rate limit exceeded, try again in 30 seconds');
    expect(result.isQuota).toBe(true);
    expect(result.retryAt).toBeDefined();
    const retryMs = new Date(result.retryAt as string).getTime();
    expect(retryMs).toBeGreaterThanOrEqual(before + 29_000);
    expect(retryMs).toBeLessThanOrEqual(before + 31_000);
  });

  it('does not flag an ordinary error message', () => {
    const result = detectQuotaSignal('Engine stream ended without a result');
    expect(result.isQuota).toBe(false);
    expect(result.message).toBe('Engine stream ended without a result');
    expect(result.retryAt).toBeUndefined();
  });
});
