import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { EngineAuthStatus } from '../engine-adapter';

/**
 * Heuristic auth check for the Claude Code CLI:
 * - `~/.claude.json` records the OAuth account (who is signed in);
 * - `~/.claude/.credentials.json` (Windows/Linux; macOS keeps it in the
 *   keychain) records the tokens and their expiry - the only place that can
 *   tell "signed in" from "signed in once, session now dead".
 * An ANTHROPIC_API_KEY also counts. The login itself runs in the terminal.
 */
export async function readClaudeAuthStatus(
  configFilePath: string,
  credentialsFilePath: string = join(dirname(configFilePath), '.claude', '.credentials.json'),
  now: () => number = Date.now,
): Promise<EngineAuthStatus> {
  const email = await readJson(configFilePath).then(oauthEmailOf, () => undefined);
  const credentials = await readJson(credentialsFilePath).then(oauthTokensOf, () => undefined);
  if (credentials && !tokensUsable(credentials, now())) {
    return { state: 'expired', ...(email ? { account: email } : {}) };
  }
  if (email) {
    return { state: 'authenticated', account: email };
  }
  if (process.env['ANTHROPIC_API_KEY']) {
    return { state: 'authenticated', account: 'API key' };
  }
  return { state: 'unauthenticated' };
}

interface OauthTokens {
  readonly hasAccessToken: boolean;
  readonly expiresAt?: number;
  readonly hasRefreshToken: boolean;
  readonly refreshTokenExpiresAt?: number;
}

/** A live access token, or a refresh token the CLI can still use, keeps the session usable. */
function tokensUsable(tokens: OauthTokens, now: number): boolean {
  const accessLive =
    tokens.hasAccessToken && (tokens.expiresAt === undefined || tokens.expiresAt > now);
  const refreshLive =
    tokens.hasRefreshToken &&
    (tokens.refreshTokenExpiresAt === undefined || tokens.refreshTokenExpiresAt > now);
  return accessLive || refreshLive;
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, 'utf8')) as unknown;
}

function oauthEmailOf(config: unknown): string | undefined {
  if (typeof config !== 'object' || config === null) {
    return undefined;
  }
  const account = (config as Record<string, unknown>)['oauthAccount'];
  if (typeof account !== 'object' || account === null) {
    return undefined;
  }
  const email = (account as Record<string, unknown>)['emailAddress'];
  return typeof email === 'string' && email.length > 0 ? email : undefined;
}

/** Never returns the tokens themselves - only whether they exist and when they lapse. */
function oauthTokensOf(credentials: unknown): OauthTokens | undefined {
  if (typeof credentials !== 'object' || credentials === null) {
    return undefined;
  }
  const oauth = (credentials as Record<string, unknown>)['claudeAiOauth'];
  if (typeof oauth !== 'object' || oauth === null) {
    return undefined;
  }
  const record = oauth as Record<string, unknown>;
  const numberOrUndefined = (value: unknown): number | undefined =>
    typeof value === 'number' ? value : undefined;
  return {
    hasAccessToken: typeof record['accessToken'] === 'string' && record['accessToken'].length > 0,
    expiresAt: numberOrUndefined(record['expiresAt']),
    hasRefreshToken:
      typeof record['refreshToken'] === 'string' && record['refreshToken'].length > 0,
    refreshTokenExpiresAt: numberOrUndefined(record['refreshTokenExpiresAt']),
  };
}
