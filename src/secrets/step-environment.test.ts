import { describe, expect, it } from 'vitest';
import { cleanBaseEnvironment, redactSecrets, stepBaseEnvironment } from './step-environment';

describe('the clean step environment', () => {
  const host = {
    PATH: '/usr/bin',
    HOME: '/Users/me',
    LANG: 'en_GB.UTF-8',
    LC_ALL: 'C',
    SSH_AUTH_SOCK: '/tmp/agent.sock',
    GITHUB_TOKEN: 'ci-job-secret',
    AWS_SECRET_ACCESS_KEY: 'nope',
    HTTP_PROXY: 'http://proxy:3128',
    EMPTY: undefined,
  };

  it('keeps only the allowlisted basics - never the host job secrets', () => {
    expect(cleanBaseEnvironment(host)).toEqual({
      PATH: '/usr/bin',
      HOME: '/Users/me',
      LANG: 'en_GB.UTF-8',
      LC_ALL: 'C',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
    });
  });

  it('adds the workflow env: pass-through names the host actually has', () => {
    expect(stepBaseEnvironment(['HTTP_PROXY', 'NOT_SET', 'GITHUB_TOKEN'], host)).toMatchObject({
      PATH: '/usr/bin',
      HTTP_PROXY: 'http://proxy:3128',
      GITHUB_TOKEN: 'ci-job-secret', // explicitly named = the author's choice
    });
    expect(stepBaseEnvironment(['HTTP_PROXY'], host)).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
  });
});

describe('redactSecrets', () => {
  it('masks every occurrence in nested strings, longest value first, and leaves other types alone', () => {
    const event = {
      type: 'agent-tool-result',
      text: 'token ghp_abc used; and ghp_abc again; nested ghp_abcdef too',
      nested: { list: ['ghp_abcdef', 42, null, { deep: 'x ghp_abc y' }] },
      count: 3,
      flag: true,
    };
    expect(redactSecrets(event, ['ghp_abc', 'ghp_abcdef', ''])).toEqual({
      type: 'agent-tool-result',
      text: 'token *** used; and *** again; nested *** too',
      nested: { list: ['***', 42, null, { deep: 'x *** y' }] },
      count: 3,
      flag: true,
    });
  });

  it('is the identity with nothing to mask', () => {
    const event = { text: 'plain' };
    expect(redactSecrets(event, [])).toBe(event);
  });
});
