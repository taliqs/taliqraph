/** `NAME=value` pairs from the command line. */
export function parseEnvPairs(pairs: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of pairs) {
    const at = pair.indexOf('=');
    const name = at < 0 ? pair : pair.slice(0, at);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`'${pair}' is not NAME=value (the name must be an identifier)`);
    }
    if (at < 0) {
      throw new Error(`'${pair}' has no value; write ${name}=value`);
    }
    out[name] = pair.slice(at + 1);
  }
  return out;
}
