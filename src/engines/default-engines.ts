import { ClaudeCodeEngine } from './claude/claude-code-engine';
import { CodexEngine } from './codex/codex-engine';
import { EngineRegistry } from './engine-registry';
import { MockEngine } from './mock/mock-engine';

/** Claude Code and Codex; the mock engine too when `TQ_MOCK_ENGINE=1` (tests, dry runs). */
export function createDefaultEngines(
  env: Readonly<Record<string, string | undefined>> = process.env,
): EngineRegistry {
  const engines = new EngineRegistry();
  engines.register(new ClaudeCodeEngine());
  engines.register(new CodexEngine());
  if (env['TQ_MOCK_ENGINE'] === '1') {
    engines.register(new MockEngine());
  }
  return engines;
}
