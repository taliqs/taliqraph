import { describe, expect, it } from 'vitest';
import type { EngineEvent } from '../engine-event';
import type { EngineRunSpec } from '../engine-adapter';
import type { ClaudeQueryFn } from './anthropic-engine';
import { AnthropicEngine } from './anthropic-engine';

const spec: EngineRunSpec = {
  systemPrompt: 'You are a test engineer.',
  userMessage: 'Fix the bug.',
  model: 'sonnet-5',
  effort: 'high',
  cwd: '/work/task-1',
  allowWrite: false,
  commandAllowlist: ['npm test'],
};

interface CapturedQuery {
  options: Record<string, unknown>;
  prompt: AsyncIterable<Record<string, unknown>>;
}

function fakeQuery(script: readonly unknown[]): { fn: ClaudeQueryFn; captured: CapturedQuery[] } {
  const captured: CapturedQuery[] = [];
  const fn: ClaudeQueryFn = (args) => {
    captured.push(args);
    return (async function* () {
      yield* script;
    })();
  };
  return { fn, captured };
}

async function collect(events: AsyncIterable<EngineEvent>): Promise<EngineEvent[]> {
  const collected: EngineEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

describe('AnthropicEngine', () => {
  it('maps the run spec onto SDK options', async () => {
    const { fn, captured } = fakeQuery([{ type: 'result', subtype: 'success', result: '' }]);
    const session = new AnthropicEngine({ queryFn: fn }).startSession(spec);
    await collect(session.events());

    const options = captured[0]?.options ?? {};
    expect(options['systemPrompt']).toBe('You are a test engineer.');
    expect(options['model']).toBe('claude-sonnet-5');
    expect(options['cwd']).toBe('/work/task-1');
    expect(options['maxThinkingTokens']).toBe(12_000);
    expect(options['settingSources']).toEqual([]);
  });

  it('streams translated events ending in done', async () => {
    const { fn } = fakeQuery([
      { type: 'assistant', message: { content: [{ type: 'text', text: 'On it.' }] } },
      {
        type: 'result',
        subtype: 'success',
        result: '',
        usage: { input_tokens: 10, output_tokens: 4 },
      },
    ]);
    const session = new AnthropicEngine({ queryFn: fn }).startSession(spec);
    const events = await collect(session.events());
    expect(events.map((event) => event.type)).toEqual(['text-delta', 'usage', 'done']);
  });

  it('enforces the tool policy through canUseTool', async () => {
    const { fn, captured } = fakeQuery([{ type: 'result', subtype: 'success', result: '' }]);
    const session = new AnthropicEngine({ queryFn: fn }).startSession(spec);
    await collect(session.events());

    const canUseTool = captured[0]?.options['canUseTool'] as (
      toolName: string,
      input: Record<string, unknown>,
    ) => Promise<{ behavior: string; message?: string }>;

    const write = await canUseTool('Write', { file_path: '/work/task-1/a.ts' });
    expect(write.behavior).toBe('deny');

    const test = await canUseTool('Bash', { command: 'npm test -- --run' });
    expect(test.behavior).toBe('allow');

    const rm = await canUseTool('Bash', { command: 'rm -rf /' });
    expect(rm.behavior).toBe('deny');
  });

  it('feeds the initial user message and later send() calls into the prompt stream', async () => {
    const { fn, captured } = fakeQuery([{ type: 'result', subtype: 'success', result: '' }]);
    const session = new AnthropicEngine({ queryFn: fn }).startSession(spec);
    session.send('Also update the changelog.');
    await collect(session.events());

    const received: Record<string, unknown>[] = [];
    const prompt = captured[0]?.prompt;
    if (prompt) {
      for await (const message of prompt) {
        received.push(message);
      }
    }
    const texts = received.map((message) => (message['message'] as { content: string }).content);
    expect(texts).toEqual(['Fix the bug.', 'Also update the changelog.']);
  });

  it('surfaces stream failures as an error event', async () => {
    const fn: ClaudeQueryFn = () =>
      (async function* () {
        yield { type: 'system', subtype: 'init' };
        throw new Error('CLI exploded');
      })();
    const session = new AnthropicEngine({ queryFn: fn }).startSession(spec);
    const events = await collect(session.events());
    expect(events).toEqual([{ type: 'error', message: 'CLI exploded' }]);
  });
});

describe('session environment', () => {
  it('replaces the subprocess environment with the spec env plus the engine auth variables', async () => {
    process.env['ANTHROPIC_TEST_MARKER'] = 'auth-rides-along';
    process.env['TQ_HOST_ONLY_VAR'] = 'must-not-leak';
    try {
      const captured: Array<{ options: Record<string, unknown> }> = [];
      const fn: ClaudeQueryFn = (args) => {
        captured.push(args as { options: Record<string, unknown> });
        return (async function* () {})();
      };
      const session = new AnthropicEngine({ queryFn: fn }).startSession({
        systemPrompt: 'x',
        userMessage: 'y',
        model: 'sonnet-5',
        cwd: '/work',
        allowWrite: false,
        commandAllowlist: [],
        env: { PATH: '/usr/bin', GH_TOKEN: 'ghp_x' },
      });
      await collect(session.events());
      expect(captured[0]?.options['env']).toEqual({
        PATH: '/usr/bin',
        GH_TOKEN: 'ghp_x',
        ...Object.fromEntries(
          Object.entries(process.env).filter(([name]) =>
            ['ANTHROPIC_', 'CLAUDE_', 'OPENAI_', 'CODEX_'].some((prefix) =>
              name.startsWith(prefix),
            ),
          ),
        ),
      });
      expect(captured[0]?.options['env']).toHaveProperty(
        'ANTHROPIC_TEST_MARKER',
        'auth-rides-along',
      );
      expect(captured[0]?.options['env']).not.toHaveProperty('TQ_HOST_ONLY_VAR');
    } finally {
      delete process.env['ANTHROPIC_TEST_MARKER'];
      delete process.env['TQ_HOST_ONLY_VAR'];
    }
  });
});
