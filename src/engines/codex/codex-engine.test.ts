import { describe, expect, it } from 'vitest';
import type { EngineEvent } from '../engine-event';
import type { EngineRunSpec } from '../engine-adapter';
import { buildExecArgs, CodexEngine } from './codex-engine';
import { translateCodexLine } from './translate-codex-line';

const spec: EngineRunSpec = {
  systemPrompt: 'You investigate.',
  userMessage: 'Why does retry loop forever?',
  model: 'gpt-5-codex',
  effort: 'high',
  cwd: '/work/task-1',
  allowWrite: false,
  commandAllowlist: [],
};

describe('buildExecArgs', () => {
  it('maps the run spec onto codex exec flags', () => {
    const args = buildExecArgs(spec);
    expect(args.slice(0, 3)).toEqual(['exec', '--json', '--skip-git-repo-check']);
    expect(args).toContain('-C');
    expect(args).toContain('/work/task-1');
    expect(args).toContain('gpt-5-codex');
    expect(args).toContain('read-only');
    expect(args).toContain('-c');
    expect(args).toContain('model_reasoning_effort="high"');
    expect(args.at(-1)).toContain('You investigate.');
    expect(args.at(-1)).toContain('Why does retry loop forever?');
  });

  it('write access widens the sandbox to workspace-write', () => {
    expect(buildExecArgs({ ...spec, allowWrite: true })).toContain('workspace-write');
  });
});

describe('translateCodexLine', () => {
  it('translates the typed thread shape end to end', () => {
    const state = { lastAgentMessage: '', model: 'gpt-5-codex' };
    const events: EngineEvent[] = [
      ...translateCodexLine('{"type":"thread.started","thread_id":"t1"}', state),
      ...translateCodexLine(
        '{"type":"item.started","item":{"id":"c1","type":"command_execution","command":"grep -rn retry src"}}',
        state,
      ),
      ...translateCodexLine(
        '{"type":"item.completed","item":{"id":"c1","type":"command_execution","command":"grep -rn retry src","exit_code":0,"aggregated_output":"src/retry.ts:42"}}',
        state,
      ),
      ...translateCodexLine(
        '{"type":"item.completed","item":{"type":"agent_message","text":"Found it.\\n```json\\n{\\"summary\\":\\"guard inverted\\"}\\n```"}}',
        state,
      ),
      ...translateCodexLine(
        '{"type":"turn.completed","usage":{"input_tokens":900,"cached_input_tokens":100,"output_tokens":80}}',
        state,
      ),
    ];
    expect(events.map((event) => event.type)).toEqual([
      'tool-call',
      'tool-result',
      'text-delta',
      'usage',
      'done',
    ]);
    const done = events.at(-1);
    expect(done?.type === 'done' && done.report).toEqual({ summary: 'guard inverted' });
    const usage = events[3];
    expect(usage?.type === 'usage' && usage.usage.tokensIn).toBe(900);
    // 800 fresh in @ $1.25/M + 100 cached @ $0.125/M + 80 out @ $10/M
    expect(usage?.type === 'usage' && usage.usage.costUsd).toBeCloseTo(0.0018125, 6);
  });

  it('tolerates the older msg envelope and garbage lines', () => {
    const state = { lastAgentMessage: '' };
    expect(translateCodexLine('not json at all', state)).toEqual([]);
    const events = translateCodexLine(
      '{"id":"0","msg":{"type":"agent_message","message":"hi"}}',
      state,
    );
    expect(events).toEqual([{ type: 'text-delta', text: 'hi' }]);
  });

  it('surfaces failures as error events', () => {
    const state = { lastAgentMessage: '' };
    expect(
      translateCodexLine(
        '{"type":"turn.failed","error":{"message":"the sandbox rejected the write"}}',
        state,
      ),
    ).toEqual([{ type: 'error', message: 'the sandbox rejected the write' }]);
  });

  it('flags a rate/usage-limit failure as quota, not a real error', () => {
    const state = { lastAgentMessage: '' };
    expect(
      translateCodexLine('{"type":"turn.failed","error":{"message":"rate limited"}}', state),
    ).toEqual([{ type: 'error', message: 'rate limited', isQuotaError: true }]);
  });
});

describe('CodexEngine', () => {
  it('streams translated events through a full scripted session', async () => {
    const lines = [
      '{"type":"item.completed","item":{"type":"agent_message","text":"done\\n```json\\n{\\"summary\\":\\"ok\\"}\\n```"}}',
      '{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":0,"output_tokens":5}}',
    ];
    const engine = new CodexEngine({
      spawnFn: async (_args, _options, onLine) => {
        for (const line of lines) {
          onLine(line);
        }
        return { exitCode: 0 };
      },
      binaryProbe: () => true,
      authFilePath: '/nonexistent/auth.json',
    });
    const collected: EngineEvent[] = [];
    for await (const event of engine.startSession(spec).events()) {
      collected.push(event);
    }
    expect(collected.map((event) => event.type)).toEqual(['text-delta', 'usage', 'done']);
  });

  it('synthesizes done when codex ends without a turn event, and reports spawn errors', async () => {
    const quiet = new CodexEngine({
      spawnFn: async (_args, _options, onLine) => {
        onLine('{"type":"item.completed","item":{"type":"agent_message","text":"plain answer"}}');
        return { exitCode: 0 };
      },
    });
    const events: EngineEvent[] = [];
    for await (const event of quiet.startSession(spec).events()) {
      events.push(event);
    }
    expect(events.at(-1)?.type).toBe('done');

    const broken = new CodexEngine({
      spawnFn: async () => {
        throw new Error('spawn codex ENOENT');
      },
    });
    const errors: EngineEvent[] = [];
    for await (const event of broken.startSession(spec).events()) {
      errors.push(event);
    }
    expect(errors[0]).toEqual({ type: 'error', message: 'spawn codex ENOENT' });
  });

  it('distinguishes not-installed from unauthenticated', async () => {
    const missing = new CodexEngine({ binaryProbe: () => false });
    expect(await missing.authStatus()).toEqual({ state: 'not-installed' });
    const noAuth = new CodexEngine({ binaryProbe: () => true, authFilePath: '/nope/auth.json' });
    expect(await noAuth.authStatus()).toEqual({ state: 'unauthenticated' });
  });
});
