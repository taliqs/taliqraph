/**
 * The clean step environment: what a script or an agent session starts
 * from when the host is the desktop or the CLI. Explicit declaration means
 * nothing if the parent's whole environment leaks in - in CI that is every job
 * secret - so only these pass by default; a workflow names anything else it
 * needs under `env:`, and secrets arrive by name only where a step lists them.
 */
const BASE_VARIABLES = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LANGUAGE',
  'TERM',
  'COLORTERM',
  'TZ',
  // git over ssh, and per-user config dirs
  'SSH_AUTH_SOCK',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  // Windows needs these to start anything at all
  'SYSTEMROOT',
  'SystemRoot',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'ProgramData',
];

const BASE_PREFIXES = ['LC_'];

/** The allowlisted base - never anything else from `source`. */
export function cleanBaseEnvironment(
  source: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) {
      continue;
    }
    if (BASE_VARIABLES.includes(name) || BASE_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      env[name] = value;
    }
  }
  return env;
}

/** The base plus the workflow's `env:` names that the host actually has. */
export function stepBaseEnvironment(
  passthrough: readonly string[] = [],
  source: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const env = cleanBaseEnvironment(source);
  for (const name of passthrough) {
    const value = source[name];
    if (value !== undefined) {
      env[name] = value;
    }
  }
  return env;
}

const REDACTED = '***';

/**
 * Replaces every occurrence of a secret value inside any string of `value`
 * (recursively through arrays and objects) - the way CI masks job secrets.
 * Longer values go first so a secret that contains another is masked whole.
 */
export function redactSecrets<T>(value: T, secretValues: readonly string[]): T {
  const needles = [...new Set(secretValues.filter((secret) => secret.length > 0))].sort(
    (left, right) => right.length - left.length,
  );
  if (needles.length === 0) {
    return value;
  }
  const scrub = (input: unknown): unknown => {
    if (typeof input === 'string') {
      let text = input;
      for (const needle of needles) {
        if (text.includes(needle)) {
          text = text.split(needle).join(REDACTED);
        }
      }
      return text;
    }
    if (Array.isArray(input)) {
      return input.map(scrub);
    }
    if (input && typeof input === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(input as Record<string, unknown>)) {
        out[key] = scrub(entry);
      }
      return out;
    }
    return input;
  };
  return scrub(value) as T;
}
