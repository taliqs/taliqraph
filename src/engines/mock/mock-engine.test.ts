import { describe, expect, it } from 'vitest';
import type { EngineEvent } from '../engine-event';
import type { EngineRunSpec } from '../engine-adapter';
import { MockEngine } from './mock-engine';

const spec: EngineRunSpec = {
  systemPrompt: 'You are a test agent.',
  userMessage: 'Say hello.',
  model: 'mock-model',
  cwd: '/tmp/workspace',
  allowWrite: false,
  commandAllowlist: [],
};

async function collect(events: AsyncIterable<EngineEvent>): Promise<EngineEvent[]> {
  const collected: EngineEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

describe('MockEngine', () => {
  it('streams the default script and ends with done', async () => {
    const session = new MockEngine().startSession(spec);
    const events = await collect(session.events());
    expect(events.at(-1)).toEqual({ type: 'done', report: { summary: 'mock run complete' } });
    expect(events.some((event) => event.type === 'usage')).toBe(true);
  });

  it('reports the JSON a "Report {…}" line in the system prompt names', async () => {
    const session = new MockEngine().startSession({
      ...spec,
      systemPrompt: ['You are a mock.', 'Report {"findings":[{"id":"f1"}]}', ''].join('\n'),
    });
    const events = await collect(session.events());
    expect(events.at(-1)).toEqual({ type: 'done', report: { findings: [{ id: 'f1' }] } });
  });

  it('streams a custom script verbatim', async () => {
    const script: EngineEvent[] = [{ type: 'text-delta', text: 'hi' }, { type: 'done' }];
    const session = new MockEngine({ script }).startSession(spec);
    expect(await collect(session.events())).toEqual(script);
  });

  it('stops streaming after cancel', async () => {
    const session = new MockEngine({ delayMs: 1 }).startSession(spec);
    const events: EngineEvent[] = [];
    for await (const event of session.events()) {
      events.push(event);
      session.cancel();
    }
    expect(events).toHaveLength(1);
  });

  it('records messages sent mid-run', () => {
    const session = new MockEngine().startSession(spec);
    session.send('change of plans');
    expect(session.sentMessages).toEqual(['change of plans']);
  });
});
