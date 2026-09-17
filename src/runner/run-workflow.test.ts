import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EngineRunSpec } from '../engines/engine-adapter';
import type { EngineEvent } from '../engines/engine-event';
import { EngineRegistry } from '../engines/engine-registry';
import { MockEngine } from '../engines/mock/mock-engine';
import type { RunEvent } from '../orchestrator/run-event';
import { describe, expect, it } from 'vitest';
import type { GateRequest, TimedRunEvent } from './types';
import { GateHandlerRequired, SecretsMissing } from './types';
import { runWorkflow } from './run-workflow';

const AGENT = (name: string, report: unknown): string => `---
name: ${name}
description: A test agent.
engine: mock
model: mock-model
---
You are ${name}.
Report ${JSON.stringify(report)}
`;

interface Fixture {
  readonly cwd: string;
  readonly pkg: string;
}

/** A scratch working folder (not a git repository) and one package folder. */
async function fixture(
  workflowYaml: string,
  agents: Readonly<Record<string, unknown>> = { worker: { summary: 'worked', done: true } },
): Promise<Fixture> {
  const base = await mkdtemp(join(tmpdir(), 'tq-run-'));
  const cwd = join(base, 'work');
  const pkg = join(base, 'pkg');
  await mkdir(cwd, { recursive: true });
  await mkdir(join(pkg, 'agents'), { recursive: true });
  await writeFile(join(pkg, 'workflow.yaml'), workflowYaml);
  for (const [name, report] of Object.entries(agents)) {
    await writeFile(join(pkg, 'agents', `${name}.md`), AGENT(name, report));
  }
  return { cwd, pkg };
}

function engines(script?: readonly EngineEvent[]): EngineRegistry {
  const registry = new EngineRegistry();
  registry.register(new MockEngine(script ? { script } : {}));
  return registry;
}

const ONE_STEP = `
name: one-step
title: One Step
inputs:
  prompt: { type: prompt, description: "What to do" }
steps:
  - id: work
    agent: worker
    input: [inputs.prompt]
    output: result
`;

const GATED = `
name: gated
title: Gated
steps:
  - id: work
    agent: worker
    input: []
    output: result
  - id: approve
    gate: approve
    show: result
  - id: finish
    agent: worker
    input: [result]
`;

const types = (events: readonly RunEvent[]): string[] => events.map((event) => event.type);

/** A mock engine that keeps every spec it was started with. */
class SpyEngine extends MockEngine {
  readonly specs: EngineRunSpec[] = [];
  override startSession(spec: EngineRunSpec): ReturnType<MockEngine['startSession']> {
    this.specs.push(spec);
    return super.startSession(spec);
  }
}

describe('runWorkflow', () => {
  it('passes streamText through to the engine, and leaves it alone by default', async () => {
    const { cwd, pkg } = await fixture(ONE_STEP);
    const quiet = new SpyEngine();
    const quietRegistry = new EngineRegistry();
    quietRegistry.register(quiet);
    await runWorkflow({
      workflow: pkg,
      inputs: { prompt: 'Do the thing' },
      cwd,
      engines: quietRegistry,
      headless: true,
      streamText: false,
    });
    expect(quiet.specs[0]?.streamText).toBe(false);

    const loud = new SpyEngine();
    const loudRegistry = new EngineRegistry();
    loudRegistry.register(loud);
    await runWorkflow({
      workflow: pkg,
      inputs: { prompt: 'Do the thing' },
      cwd,
      engines: loudRegistry,
      headless: true,
    });
    expect(loud.specs[0]?.streamText).toBeUndefined();
  });

  it('runs a one-step agent workflow headless and returns its output, metrics and exit code', async () => {
    const { cwd, pkg } = await fixture(ONE_STEP);
    const seen: TimedRunEvent[] = [];
    const result = await runWorkflow({
      workflow: pkg,
      inputs: { prompt: 'Do the thing' },
      cwd,
      engines: engines(),
      headless: true,
      onEvent: (event) => seen.push(event),
    });
    expect(result.status).toBe('done');
    expect(result.exitCode).toBe(0);
    expect(result.output).toMatchObject({ summary: 'worked', done: true });
    // no finish step and no model call: a plain line, not a list of key names
    expect(result.summary).toBe('One Step finished');
    expect(result.workspace).toBe(cwd);
    expect(result.metrics.steps).toHaveLength(1);
    expect(result.metrics.steps[0]).toMatchObject({
      id: 'work',
      kind: 'agent',
      status: 'done',
      engine: 'mock',
      model: 'mock-model',
      tokens: { tokensIn: 120, tokensOut: 48, total: 168 },
    });
    expect(result.metrics.tokens.total).toBe(168);
    expect(types(result.events)).toEqual([
      'run-started',
      'step-started',
      'agent-text',
      'agent-text',
      'step-usage',
      'step-completed',
      'run-completed',
    ]);
    expect(seen.map((event) => event.type)).toEqual(types(result.events));
    expect(seen.every((event) => typeof event.at === 'string')).toBe(true);
  });

  it('refuses a workflow with a gate before anything runs when nothing can answer it', async () => {
    const { cwd, pkg } = await fixture(GATED);
    const seen: RunEvent[] = [];
    await expect(
      runWorkflow({ workflow: pkg, cwd, engines: engines(), onEvent: (e) => seen.push(e) }),
    ).rejects.toMatchObject({ name: 'GateHandlerRequired', stepIds: ['approve'] });
    expect(seen).toEqual([]);
    await expect(runWorkflow({ workflow: pkg, cwd, engines: engines() })).rejects.toBeInstanceOf(
      GateHandlerRequired,
    );
  });

  it('puts a gate to onGate and applies an approval with its note', async () => {
    const { cwd, pkg } = await fixture(GATED);
    const requests: GateRequest[] = [];
    const result = await runWorkflow({
      workflow: pkg,
      cwd,
      engines: engines(),
      onGate: (gate) => {
        requests.push(gate);
        return Promise.resolve({ approved: true, note: 'looks good' });
      },
    });
    expect(result.status).toBe('done');
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      stepId: 'approve',
      kind: 'approve',
      show: ['result'],
      shown: { result: { summary: 'worked', done: true } },
    });
    const resolved = result.events.find((event) => event.type === 'gate-resolved');
    expect(resolved).toMatchObject({ stepId: 'approve', approved: true, note: 'looks good' });
    expect(result.metrics.steps.map((step) => step.id)).toEqual(['work', 'finish']);
  });

  it('a rejection with no earlier agent step to redo fails the run', async () => {
    const { cwd, pkg } = await fixture(`
name: gate-first
title: Gate First
inputs:
  prompt: { type: prompt, description: "What to do" }
steps:
  - id: approve
    gate: approve
    show: inputs.prompt
  - id: work
    agent: worker
    input: []
`);
    const result = await runWorkflow({
      workflow: pkg,
      inputs: { prompt: 'Check first' },
      cwd,
      engines: engines(),
      onGate: () => Promise.resolve({ approved: false, note: 'not now' }),
    });
    expect(result.status).toBe('failed');
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("'approve' was rejected");
    expect(types(result.events)).toEqual([
      'run-started',
      'gate-opened',
      'gate-resolved',
      'run-failed',
    ]);
  });

  it("answers an agent's question through onGate and feeds the answer back", async () => {
    const { cwd, pkg } = await fixture(ONE_STEP);
    const requests: GateRequest[] = [];
    const result = await runWorkflow({
      workflow: pkg,
      inputs: { prompt: 'Ask me' },
      cwd,
      engines: engines([
        { type: 'done', report: { ask_user: 'Which colour?', options: ['red', 'blue'] } },
        { type: 'done', report: { summary: 'painted' } },
      ]),
      onGate: (gate) => {
        requests.push(gate);
        return Promise.resolve({ approved: true, answer: 'blue' });
      },
    });
    expect(result.status).toBe('done');
    expect(requests[0]).toMatchObject({
      stepId: 'work',
      kind: 'question',
      question: 'Which colour?',
      suggestions: ['red', 'blue'],
    });
    expect(result.events.find((event) => event.type === 'gate-resolved')).toMatchObject({
      approved: true,
      note: 'blue',
    });
    expect(result.output).toMatchObject({ summary: 'painted' });
  });

  it('fails instead of hanging when an agent asks and neither onGate nor headless is set', async () => {
    const { cwd, pkg } = await fixture(ONE_STEP);
    const result = await runWorkflow({
      workflow: pkg,
      inputs: { prompt: 'Ask me' },
      cwd,
      engines: engines([{ type: 'done', report: { ask_user: 'Which colour?' } }]),
    });
    expect(result.status).toBe('failed');
    expect(result.message).toContain("'work' paused the run with a question");
    expect(result.message).toContain('onGate');
  });

  it('throws SecretsMissing for a required secret found nowhere, and runs once it is given', async () => {
    const { cwd, pkg } = await fixture(`
name: needs-secret
title: Needs Secret
secrets: [TQ_TEST_TOKEN, TQ_TEST_OPTIONAL?]
steps:
  - id: work
    agent: worker
    input: []
    secrets: [TQ_TEST_TOKEN]
`);
    delete process.env['TQ_TEST_TOKEN'];
    await expect(
      runWorkflow({ workflow: pkg, cwd, engines: engines(), headless: true }),
    ).rejects.toMatchObject({ name: 'SecretsMissing', names: ['TQ_TEST_TOKEN'] });
    await expect(
      runWorkflow({ workflow: pkg, cwd, engines: engines(), headless: true }),
    ).rejects.toBeInstanceOf(SecretsMissing);
    const result = await runWorkflow({
      workflow: pkg,
      cwd,
      engines: engines([
        { type: 'text-delta', text: 'the token is hunter2-secret' },
        { type: 'done', report: { summary: 'ok' } },
      ]),
      headless: true,
      secrets: { TQ_TEST_TOKEN: 'hunter2-secret' },
    });
    expect(result.status).toBe('done');
    const text = result.events.find((event) => event.type === 'agent-text');
    expect(text).toMatchObject({ text: 'the token is ***' });
  });

  it('continues a run interrupted after its first step from its events', async () => {
    const { cwd, pkg } = await fixture(
      `
name: two-steps
title: Two Steps
steps:
  - id: first
    agent: worker
    input: []
    output: plan
  - id: second
    agent: finisher
    input: [plan]
`,
      { worker: { plan: 'A' }, finisher: { summary: 'finished' } },
    );
    const earlier: RunEvent[] = [
      { type: 'run-started', workflowName: 'two-steps' },
      { type: 'step-started', stepId: 'first', stepKind: 'agent', attempt: 1 },
      { type: 'step-completed', stepId: 'first', report: { plan: 'A' } },
      { type: 'step-started', stepId: 'second', stepKind: 'agent', attempt: 1 },
      { type: 'run-interrupted', reason: 'The app closed while this was running' },
    ];
    const result = await runWorkflow({
      workflow: pkg,
      cwd,
      engines: engines(),
      headless: true,
      resumeFrom: earlier,
    });
    expect(result.status).toBe('done');
    expect(result.output).toMatchObject({ summary: 'finished' });
    const fresh = result.events.slice(earlier.length);
    expect(types(fresh)).toEqual([
      'run-resumed',
      'step-started',
      'agent-text',
      'agent-text',
      'step-usage',
      'step-completed',
      'run-completed',
    ]);
    expect(fresh.filter((event) => event.type === 'step-started')).toEqual([
      expect.objectContaining({ stepId: 'second' }),
    ]);
    expect(result.metrics.steps.map((step) => [step.id, step.status])).toEqual([
      ['first', 'done'],
      ['second', 'done'],
    ]);
  });

  it('works in the folder itself when it is not a git repository, whatever the workflow prefers', async () => {
    const { cwd, pkg } = await fixture(ONE_STEP);
    const result = await runWorkflow({
      workflow: pkg,
      inputs: { prompt: 'Here' },
      cwd,
      engines: engines(),
      headless: true,
    });
    expect(result.workspace).toBe(cwd);
  });

  it('cancels through the signal', async () => {
    const { cwd, pkg } = await fixture(ONE_STEP);
    const controller = new AbortController();
    const result = await runWorkflow({
      workflow: pkg,
      inputs: { prompt: 'Slow' },
      cwd,
      engines: engines(),
      headless: true,
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type === 'step-started') {
          controller.abort();
        }
      },
    });
    expect(result.status).toBe('cancelled');
    expect(result.exitCode).toBe(130);
    expect(result.events.at(-1)?.type).toBe('run-cancelled');
  });

  it('the log says what the run was given and what each step was handed', async () => {
    const { cwd, pkg } = await fixture(ONE_STEP);
    const result = await runWorkflow({
      workflow: pkg,
      cwd,
      engines: engines(),
      headless: true,
      inputs: { prompt: 'what changed' },
    });
    const started = result.events.find((event) => event.type === 'run-started');
    expect(started?.type === 'run-started' && started.inputs).toEqual({ prompt: 'what changed' });
    const step = result.events.find((event) => event.type === 'step-started');
    expect(step?.type === 'step-started' && step.stepKind).toBe('agent');
    expect(step?.type === 'step-started' && step.input).toEqual(['inputs.prompt']);
  });
});
