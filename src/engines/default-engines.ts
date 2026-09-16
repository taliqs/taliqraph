import { AnthropicEngine } from './anthropic/anthropic-engine';
import { EngineRegistry } from './engine-registry';
import { MockEngine } from './mock/mock-engine';

/** The Anthropic engine; the mock engine too when `TQ_MOCK_ENGINE=1` (tests, dry runs). */
export function createDefaultEngines(
  env: Readonly<Record<string, string | undefined>> = process.env,
): EngineRegistry {
  const engines = new EngineRegistry();
  engines.register(new AnthropicEngine());
  if (env['TQ_MOCK_ENGINE'] === '1') {
    engines.register(new MockEngine());
  }
  return engines;
}
