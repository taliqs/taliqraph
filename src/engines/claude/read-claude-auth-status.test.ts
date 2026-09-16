import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readClaudeAuthStatus } from './read-claude-auth-status';

async function writeTempConfig(content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tq-claude-auth-'));
  const filePath = join(dir, '.claude.json');
  await writeFile(filePath, content, 'utf8');
  return filePath;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('readClaudeAuthStatus', () => {
  it('reports the OAuth account from the CLI config', async () => {
    const filePath = await writeTempConfig(
      JSON.stringify({ oauthAccount: { emailAddress: 'dev@example.com' } }),
    );
    expect(await readClaudeAuthStatus(filePath)).toEqual({
      state: 'authenticated',
      account: 'dev@example.com',
    });
  });

  it('falls back to the API key env var', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');
    expect(await readClaudeAuthStatus('/nope/missing.json')).toEqual({
      state: 'authenticated',
      account: 'API key',
    });
  });

  it('reports unauthenticated when neither exists', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    const filePath = await writeTempConfig(JSON.stringify({ hasCompletedOnboarding: true }));
    expect(await readClaudeAuthStatus(filePath)).toEqual({ state: 'unauthenticated' });
  });
});

describe('readClaudeAuthStatus - token expiry', () => {
  const NOW = Date.parse('2026-09-06T16:00:00.000Z');
  const later = NOW + 3_600_000;
  const earlier = NOW - 3_600_000;

  async function writeBoth(credentials: unknown): Promise<{ config: string; credentials: string }> {
    const dir = await mkdtemp(join(tmpdir(), 'tq-claude-auth-'));
    const config = join(dir, '.claude.json');
    await writeFile(
      config,
      JSON.stringify({ oauthAccount: { emailAddress: 'dev@example.com' } }),
      'utf8',
    );
    const credentialsPath = join(dir, 'credentials.json');
    await writeFile(credentialsPath, JSON.stringify(credentials), 'utf8');
    return { config, credentials: credentialsPath };
  }

  it('is expired when the access token lapsed and there is no refresh token - the account is still named', async () => {
    const paths = await writeBoth({
      claudeAiOauth: { accessToken: 'x', expiresAt: 0, refreshTokenExpiresAt: later },
    });
    expect(await readClaudeAuthStatus(paths.config, paths.credentials, () => NOW)).toEqual({
      state: 'expired',
      account: 'dev@example.com',
    });
  });

  it('stays authenticated while the access token or a refresh token is still valid', async () => {
    const live = await writeBoth({ claudeAiOauth: { accessToken: 'x', expiresAt: later } });
    expect((await readClaudeAuthStatus(live.config, live.credentials, () => NOW)).state).toBe(
      'authenticated',
    );
    const refreshable = await writeBoth({
      claudeAiOauth: {
        accessToken: 'x',
        expiresAt: earlier,
        refreshToken: 'r',
        refreshTokenExpiresAt: later,
      },
    });
    expect(
      (await readClaudeAuthStatus(refreshable.config, refreshable.credentials, () => NOW)).state,
    ).toBe('authenticated');
  });

  it('falls back to the account heuristic when there is no credentials file (macOS keychain)', async () => {
    const paths = await writeBoth({});
    expect(
      (await readClaudeAuthStatus(paths.config, join(paths.credentials, 'missing'), () => NOW))
        .state,
    ).toBe('authenticated');
  });
});
