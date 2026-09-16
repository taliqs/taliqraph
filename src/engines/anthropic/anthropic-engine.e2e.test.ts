import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { EngineEvent } from '../engine-event';
import { AnthropicEngine } from './anthropic-engine';

// Live test against the real Claude Code SDK + the machine's own login.
// Run with: TQ_E2E_CLAUDE=1 pnpm test
const LIVE = process.env['TQ_E2E_CLAUDE'] === '1';

describe.runIf(LIVE)('AnthropicEngine (live)', () => {
  it('writes a file inside the workspace and reports real usage', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'tq-claude-e2e-'));
    const engine = new AnthropicEngine();
    const session = engine.startSession({
      systemPrompt:
        'You are a precise assistant. Do exactly what is asked using your tools, then stop.',
      userMessage:
        'Create a file named hello.txt containing exactly this line: hello from taliqraph',
      model: 'haiku-4-5',
      cwd: workspace,
      allowWrite: true,
      commandAllowlist: [],
    });

    const events: EngineEvent[] = [];
    for await (const event of session.events()) {
      events.push(event);
      if (event.type === 'done' || event.type === 'error') {
        break;
      }
    }
    session.cancel();

    expect(events.at(-1)?.type).toBe('done');
    const usage = events.find((event) => event.type === 'usage');
    expect(usage && usage.type === 'usage' && usage.usage.tokensOut).toBeGreaterThan(0);

    const written = await readFile(join(workspace, 'hello.txt'), 'utf8');
    expect(written).toContain('hello from taliqraph');
  }, 240_000);
});
