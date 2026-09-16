/**
 * The variables an engine's own process needs to authenticate and behave. Kept
 * out of the workflow's declared secrets on purpose: engine credentials are
 * engine configuration. Applied on top of a clean session environment; never
 * offered to scripts or to the agent as a workflow secret.
 */
const ENGINE_AUTH_PREFIXES = ['ANTHROPIC_', 'CLAUDE_', 'OPENAI_', 'CODEX_'];

export function engineAuthEnvironment(
  source: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && ENGINE_AUTH_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      picked[name] = value;
    }
  }
  return picked;
}
