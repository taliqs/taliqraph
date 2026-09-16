import { describe, expect, it } from 'vitest';
import { describeAuthFailure, isAuthFailure } from './auth-error';

describe('isAuthFailure', () => {
  it('recognises the Claude Code expired-login reply and other sign-in failures', () => {
    expect(
      isAuthFailure('Failed to authenticate: OAuth session expired and could not be refreshed'),
    ).toBe(true);
    expect(isAuthFailure('Not logged in. Please run /login')).toBe(true);
    expect(isAuthFailure('Invalid API key · Please run /login')).toBe(true);
    expect(isAuthFailure('{"type":"error","error":{"type":"authentication_error"}}')).toBe(true);
  });

  it('leaves ordinary prose alone, even when it talks about authentication', () => {
    expect(
      isAuthFailure(
        'The login flow failed to authenticate users whose session expired; I fixed the refresh.',
      ),
    ).toBe(false);
    expect(isAuthFailure('Fixing the timer now.')).toBe(false);
    expect(isAuthFailure(`Failed to authenticate ${'x'.repeat(400)}`)).toBe(false);
  });

  it('describes the failure with the two ways out', () => {
    expect(describeAuthFailure('Failed to authenticate: OAuth session expired.')).toBe(
      'Failed to authenticate: OAuth session expired - sign in again (`taliqraph login`, or wherever your host signs engines in), then resume the run.',
    );
  });
});
