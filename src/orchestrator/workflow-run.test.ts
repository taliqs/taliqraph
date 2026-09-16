import type { AgentDefinition } from '../definitions/agent/agent-definition';
import type { WorkflowDefinition } from '../definitions/workflow/workflow-definition';
import { EngineRegistry } from '../engines/engine-registry';
import { describe, expect, it } from 'vitest';
import type { RunEvent } from './run-event';
import {
  ScriptedEngine,
  agentDef,
  context,
  done,
  eventTypes,
  featureDev,
  makeDeps,
  reviewLoopChild,
  reviewWorkflow,
  text,
} from './test-harness';
import type { OrchestratorDeps } from './workflow-run';
import { WorkflowRun } from './workflow-run';

describe('WorkflowRun', () => {
  it("routes each step to its agent's engine - mixed-engine workflows", async () => {
    class SecondEngine extends ScriptedEngine {
      override readonly id = 'second';
      override readonly label = 'Second';
    }
    const first = new ScriptedEngine([[done({ plan: 'from-scripted' })]]);
    const second = new SecondEngine([[done({ files: 1 })]]);
    const registry = new EngineRegistry();
    registry.register(first);
    registry.register(second);

    const agents: Record<string, AgentDefinition> = {
      planner: agentDef('planner'),
      engineer: { ...agentDef('engineer'), engine: 'second' },
    };
    const events: RunEvent[] = [];
    const deps: OrchestratorDeps = {
      engines: registry,
      resolveAgent: (name) => agents[name],
      resolveWorkflow: () => undefined,
      runScript: () => Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }),
      emit: (event) => {
        events.push(event);
      },
    };
    const workflow: WorkflowDefinition = {
      name: 'mixed',
      title: 'Mixed',
      scope: 'global',
      steps: [
        { kind: 'agent', id: 'plan', agent: 'planner', input: ['inputs.prompt'], output: 'plan' },
        { kind: 'agent', id: 'implement', agent: 'engineer', input: ['plan'] },
      ],
    };
    const run = new WorkflowRun(workflow, context, deps);
    await run.start();
    expect(run.currentStatus).toBe('completed');
    expect(first.specs).toHaveLength(1); // planner ran on scripted
    expect(second.specs).toHaveLength(1); // engineer ran on second
    expect(second.specs[0]?.userMessage).toContain('from-scripted'); // outputs cross engines
  });

  it('runs plan → gate → implement → auto script to completion', async () => {
    const engine = new ScriptedEngine([
      [text('Planning…'), done({ steps: ['fix timer'] })],
      [{ type: 'tool-call', callId: 'c1', toolName: 'Edit', input: {} }, done({ files: 1 })],
    ]);
    const { deps, events, scriptRuns, metas } = makeDeps(engine);
    const run = new WorkflowRun(featureDev, context, deps);

    await run.start();
    expect(run.currentStatus).toBe('waiting-gate');
    expect(run.waitingStep()).toEqual({ kind: 'gate', stepId: 'approve-plan' });

    await run.resolveGate('approve-plan', true);
    expect(run.currentStatus).toBe('completed');

    expect(engine.specs[1]?.userMessage).toContain('"fix timer"');
    expect(engine.specs[1]?.systemPrompt).toMatch(/^You are engineer\./);
    expect(engine.specs[1]?.systemPrompt).toContain('# Commands'); // the policy rides in the prompt
    // `with:` params ride along under their own keys
    expect(scriptRuns).toEqual([
      { command: 'github-create-pr', inputs: { inputs: context.inputs, args: [], draft: true } },
    ]);
    expect(run.collectedOutputs()['plan']).toEqual({ steps: ['fix timer'] });
    expect(metas.map((meta) => meta.stepId)).toEqual(['plan', 'implement']);
    expect(eventTypes(events)).toEqual([
      'run-started',
      'step-started',
      'agent-text',
      'step-completed',
      'gate-opened',
      'gate-resolved',
      'step-started',
      'agent-tool-call',
      'step-completed',
      'step-started',
      'agent-tool-call',
      'agent-tool-result',
      'step-completed',
      'run-completed',
    ]);
  });

  it('re-runs the preceding agent with feedback when a gate is rejected', async () => {
    const engine = new ScriptedEngine([
      [done({ plan: 'v1' })],
      [done({ plan: 'v2' })],
      [done({ files: 1 })],
    ]);
    const { deps, events } = makeDeps(engine);
    const run = new WorkflowRun(featureDev, context, deps);

    await run.start();
    await run.resolveGate('approve-plan', false, 'Too big - split it.');
    expect(run.currentStatus).toBe('waiting-gate');
    expect(engine.specs[1]?.userMessage).toContain('Too big - split it.');
    expect(
      events.some((event) => event.type === 'loop-back' && event.reason === 'gate-rejected'),
    ).toBe(true);

    await run.resolveGate('approve-plan', true);
    expect(run.currentStatus).toBe('completed');
    expect(run.collectedOutputs()['plan']).toEqual({ plan: 'v2' });
  });

  it('keeps looping plan → gate for as many rounds as the user wants - no reject cap', async () => {
    const rounds = 6;
    const engine = new ScriptedEngine([
      ...Array.from({ length: rounds + 1 }, (_, i) => [done({ plan: `v${i + 1}` })]),
      [done({ files: 1 })],
    ]);
    const { deps, events } = makeDeps(engine);
    const run = new WorkflowRun(featureDev, context, deps);

    await run.start();
    for (let round = 1; round <= rounds; round += 1) {
      await run.resolveGate('approve-plan', false, `Round ${round}: not like that, like this.`);
      expect(run.currentStatus).toBe('waiting-gate'); // re-planned and asking again, never failed
      expect(engine.specs[round]?.userMessage).toContain(
        `Round ${round}: not like that, like this.`,
      );
    }
    const iterations = events
      .filter((event) => event.type === 'loop-back' && event.reason === 'gate-rejected')
      .map((event) => (event.type === 'loop-back' ? event.iteration : 0));
    expect(iterations).toEqual([1, 2, 3, 4, 5, 6]);

    await run.resolveGate('approve-plan', true);
    expect(run.currentStatus).toBe('completed');
    expect(run.collectedOutputs()['plan']).toEqual({ plan: `v${rounds + 1}` });
  });

  it('loops implement ↔ review while the sub-workflow reports blocking', async () => {
    const engine = new ScriptedEngine([
      [done({ files: 1 })], // implement #1
      [done({ blocking: true, findings: ['missed destroy()'] })], // review #1
      [done({ files: 2 })], // implement #2 (with findings as feedback)
      [done({ blocking: false })], // review #2
    ]);
    const { deps, events } = makeDeps(engine, { 'review-loop': reviewLoopChild });
    const run = new WorkflowRun(reviewWorkflow(3), context, deps);

    await run.start();
    expect(run.currentStatus).toBe('completed');
    expect(engine.specs[2]?.userMessage).toContain('missed destroy()');

    const loopBacks = events.filter((event) => event.type === 'loop-back');
    expect(loopBacks).toEqual([
      expect.objectContaining({
        fromStepId: 'review',
        toStepId: 'implement',
        iteration: 1,
        reason: 'blocking-review',
      }),
    ]);
    expect(events.some((event) => 'stepId' in event && event.stepId === 'review/bug-hunt')).toBe(
      true,
    );
  });

  it('opens a gate when review loops are exhausted and still blocking', async () => {
    const engine = new ScriptedEngine([
      [done({ files: 1 })],
      [done({ blocking: true })],
      [done({ files: 2 })],
      [done({ blocking: true })],
    ]);
    const { deps } = makeDeps(engine, { 'review-loop': reviewLoopChild });
    const run = new WorkflowRun(reviewWorkflow(1), context, deps);

    await run.start();
    expect(run.currentStatus).toBe('waiting-gate');
    expect(run.waitingStep()).toEqual({ kind: 'gate', stepId: 'review' });

    await run.resolveGate('review', true);
    expect(run.currentStatus).toBe('completed');
  });

  it('retries a failed agent step once, then fails the run', async () => {
    const engine = new ScriptedEngine([
      [{ type: 'error', message: 'engine exploded' }],
      [{ type: 'error', message: 'engine exploded again' }],
    ]);
    const { deps, events } = makeDeps(engine);
    const run = new WorkflowRun(featureDev, context, deps);

    await run.start();
    expect(run.currentStatus).toBe('failed');
    expect(events.filter((event) => event.type === 'step-failed')).toHaveLength(2);
    const failure = events.at(-1);
    expect(failure?.type === 'run-failed' && failure.message).toContain('engine exploded again');
  });

  it('a usage-limit error interrupts (not fails) the run without retrying', async () => {
    const engine = new ScriptedEngine([
      [
        {
          type: 'error',
          message: 'Claude AI usage limit reached - resets 3:00 PM',
          isQuotaError: true,
          retryAt: '2286-01-01T00:00:00.000Z',
        },
      ],
    ]);
    const { deps, events } = makeDeps(engine);
    const run = new WorkflowRun(featureDev, context, deps);

    await run.start();
    expect(run.currentStatus).toBe('cancelled');
    // Only the one attempt - retrying immediately would just hit the same wall.
    expect(engine.sessions).toHaveLength(1);
    expect(events.some((event) => event.type === 'run-failed')).toBe(false);
    expect(events.at(-1)).toEqual({
      type: 'run-interrupted',
      reason: 'Claude AI usage limit reached - resets 3:00 PM',
      cause: 'quota',
      retryAt: '2286-01-01T00:00:00.000Z',
    });
  });

  it('an expired engine login interrupts the run with cause auth instead of retrying', async () => {
    const engine = new ScriptedEngine([
      [
        {
          type: 'error',
          message: 'Failed to authenticate: OAuth session expired - sign in again, then resume.',
          isAuthError: true,
        },
      ],
    ]);
    const { deps, events } = makeDeps(engine);
    const run = new WorkflowRun(featureDev, context, deps);

    await run.start();
    expect(run.currentStatus).toBe('cancelled');
    expect(engine.sessions).toHaveLength(1);
    expect(events.some((event) => event.type === 'run-failed')).toBe(false);
    expect(events.at(-1)).toEqual({
      type: 'run-interrupted',
      reason: 'Failed to authenticate: OAuth session expired - sign in again, then resume.',
      cause: 'auth',
    });
  });
  it('resuming a quota-interrupted run just re-runs the interrupted step, like a crash resume', async () => {
    const engine = new ScriptedEngine([
      [{ type: 'error', message: 'rate_limit_error: slow down', isQuotaError: true }],
    ]);
    const { deps, events } = makeDeps(engine);
    const run = new WorkflowRun(featureDev, context, deps);
    await run.start();
    expect(run.currentStatus).toBe('cancelled');

    const secondEngine = new ScriptedEngine([[done({ plan: 'v1' })]]);
    const resumeDeps = {
      ...deps,
      engines: (() => {
        const registry = new EngineRegistry();
        registry.register(secondEngine);
        return registry;
      })(),
    };
    const resumed = WorkflowRun.resume(featureDev, context, resumeDeps, [
      ...events,
      { type: 'run-resumed' },
    ]);
    expect(resumed.currentStatus).toBe('running');
    await resumed.continueRun();
    expect(resumed.currentStatus).toBe('waiting-gate');
    expect(secondEngine.sessions).toHaveLength(1);
  });

  it('relativizes workspace paths in tool-call details', async () => {
    const engine = new ScriptedEngine([
      [
        {
          type: 'tool-call',
          callId: 'c1',
          toolName: 'Read',
          input: { file_path: '/work/task-1/src/drm/session.ts' },
        },
        done({ plan: 'v1' }),
      ],
    ]);
    const { deps, events } = makeDeps(engine);
    await new WorkflowRun(featureDev, context, deps).start();
    expect(events.find((event) => event.type === 'agent-tool-call')).toMatchObject({
      toolName: 'Read',
      detail: 'src/drm/session.ts',
      input: { file_path: '/work/task-1/src/drm/session.ts' },
    });
  });

  it('announces agent, model, and effort on step start', async () => {
    const engine = new ScriptedEngine([[done({ plan: 'v1' })]]);
    const { deps, events } = makeDeps(engine);
    const run = new WorkflowRun(featureDev, context, deps);
    await run.start();
    expect(events.find((event) => event.type === 'step-started')).toMatchObject({
      stepId: 'plan',
      agentName: 'planner',
      model: 'model-x',
      effort: 'med',
    });
  });

  it('cancel mid-step cancels the engine session and the run', async () => {
    const engine = new ScriptedEngine([[text('working…')]], true);
    const { deps, events } = makeDeps(engine);
    const run = new WorkflowRun(featureDev, context, deps);

    const started = run.start();
    await new Promise((resolve) => setTimeout(resolve, 10));
    run.cancel();
    await started;

    expect(run.currentStatus).toBe('cancelled');
    expect(engine.sessions[0]?.cancelled).toBe(true);
    expect(events.at(-1)?.type).toBe('run-cancelled');
  });

  it("a pipeline sub-workflow's gate pauses the run instead of failing it", async () => {
    const gatedChild: WorkflowDefinition = {
      ...reviewLoopChild,
      steps: [
        { kind: 'agent', id: 'x', agent: 'reviewer', input: [] },
        { kind: 'gate', gate: 'approve', id: 'child-gate', show: [], editable: false },
      ],
    };
    const engine = new ScriptedEngine([[done()], [done()]]);
    const { deps } = makeDeps(engine, { 'review-loop': gatedChild });
    const run = new WorkflowRun(reviewWorkflow(1), context, deps);

    await run.start();
    expect(run.currentStatus).toBe('waiting-gate');
    expect(run.waitingStep()).toEqual({ kind: 'gate', stepId: 'review/child-gate' });
  });

  it('resumes from a persisted log while waiting at a gate', async () => {
    const firstEngine = new ScriptedEngine([[done({ steps: ['a'] })]]);
    const first = makeDeps(firstEngine);
    const original = new WorkflowRun(featureDev, context, first.deps);
    await original.start();
    expect(original.currentStatus).toBe('waiting-gate');

    const secondEngine = new ScriptedEngine([[done({ files: 3 })]]);
    const second = makeDeps(secondEngine);
    const resumed = WorkflowRun.resume(featureDev, context, second.deps, first.events);
    expect(resumed.currentStatus).toBe('waiting-gate');
    expect(resumed.waitingStep()).toEqual({ kind: 'gate', stepId: 'approve-plan' });

    await resumed.resolveGate('approve-plan', true);
    expect(resumed.currentStatus).toBe('completed');
    expect(secondEngine.specs[0]?.userMessage).toContain('"a"'); // plan output survived the restart
    expect(second.scripts).toEqual(['github-create-pr']);
  });

  it('resumes a cancelled run back to its open gate via run-resumed', async () => {
    const firstEngine = new ScriptedEngine([[done({ steps: ['a'] })]]);
    const first = makeDeps(firstEngine);
    const original = new WorkflowRun(featureDev, context, first.deps);
    await original.start();
    original.cancel(); // user stopped it while waiting at approve-plan

    const log: RunEvent[] = [...first.events, { type: 'run-resumed' }];
    const secondEngine = new ScriptedEngine([[done({ files: 1 })]]);
    const second = makeDeps(secondEngine);
    const resumed = WorkflowRun.resume(featureDev, context, second.deps, log);

    expect(resumed.currentStatus).toBe('waiting-gate');
    await resumed.resolveGate('approve-plan', true);
    expect(resumed.currentStatus).toBe('completed');
  });

  it('resumes mid-step by re-running the interrupted step', async () => {
    const log: RunEvent[] = [
      { type: 'run-started', workflowName: 'feature-dev' },
      { type: 'step-started', stepId: 'plan', stepKind: 'agent', attempt: 1 },
      { type: 'step-completed', stepId: 'plan', report: { steps: ['a'] } },
      { type: 'gate-opened', stepId: 'approve-plan', show: ['plan'] },
      { type: 'gate-resolved', stepId: 'approve-plan', approved: true },
      { type: 'step-started', stepId: 'implement', stepKind: 'agent', attempt: 1 },
      // crash here - implement never completed
    ];
    const engine = new ScriptedEngine([[done({ files: 1 })]]);
    const { deps, scripts } = makeDeps(engine);
    const resumed = WorkflowRun.resume(featureDev, context, deps, log);

    expect(resumed.currentStatus).toBe('running');
    await resumed.continueRun();
    expect(resumed.currentStatus).toBe('completed');
    expect(engine.specs[0]?.userMessage).toContain('"a"');
    expect(scripts).toHaveLength(1);
  });
});

describe('script steps, agent loop-backs, and run policy', () => {
  it('runs a script step: command executes in the workspace, JSON stdout becomes its output', async () => {
    const flow: WorkflowDefinition = {
      name: 'with-script',
      title: 'With Script',
      scope: 'global',
      steps: [
        { kind: 'script', id: 'tests', command: 'pnpm test', output: 'testResults' },
        { kind: 'agent', id: 'work', agent: 'engineer', input: ['testResults'] },
      ],
    };
    const engine = new ScriptedEngine([[done({ ok: 1 })]]);
    const { deps, events, scripts } = makeDeps(engine);
    const run = new WorkflowRun(flow, context, deps);
    await run.start();

    expect(run.currentStatus).toBe('completed');
    expect(scripts).toEqual(['pnpm test']);
    expect(run.collectedOutputs()['testResults']).toEqual({ passed: true });
    expect(engine.specs[0]?.userMessage).toContain('"passed": true');
    const toolCall = events.find((event) => event.type === 'agent-tool-call');
    expect(toolCall).toMatchObject({ toolName: 'Script', detail: 'pnpm test' });
  });

  it('fails the run when a script exits nonzero', async () => {
    const flow: WorkflowDefinition = {
      name: 'script-fails',
      title: 'Script Fails',
      scope: 'global',
      steps: [{ kind: 'script', id: 'lint', command: 'run-and-fail' }],
    };
    const { deps, events } = makeDeps(new ScriptedEngine([]));
    const run = new WorkflowRun(flow, context, deps);
    await run.start();

    expect(run.currentStatus).toBe('failed');
    const failed = events.find((event) => event.type === 'step-failed');
    expect(failed && 'message' in failed && failed.message).toContain('exit 1');
    expect(failed && 'message' in failed && failed.message).toContain('boom');
  });

  it('loops an agent review step back to the implementer on blocking findings', async () => {
    const flow: WorkflowDefinition = {
      name: 'agent-loop',
      title: 'Agent Loop',
      scope: 'global',
      steps: [
        { kind: 'agent', id: 'implement', agent: 'engineer', input: ['inputs.prompt'] },
        {
          kind: 'agent',
          id: 'security-scan',
          agent: 'reviewer',
          input: [],
          onBlocking: { gotoStepId: 'implement', maxLoops: 2, then: 'fail' },
        },
      ],
    };
    const engine = new ScriptedEngine([
      [done({ files: 1 })],
      [done({ blocking: true, findings: ['injection'] })],
      [done({ files: 2 })],
      [done({ blocking: false, findings: [] })],
    ]);
    const { deps, events } = makeDeps(engine);
    const run = new WorkflowRun(flow, context, deps);
    await run.start();

    expect(run.currentStatus).toBe('completed');
    const loop = events.find((event) => event.type === 'loop-back');
    expect(loop).toMatchObject({
      fromStepId: 'security-scan',
      toStepId: 'implement',
      reason: 'blocking-review',
    });
    expect(engine.specs[2]?.userMessage).toContain('injection'); // implementer saw the findings
    expect(engine.specs).toHaveLength(4);
  });

  it('when.max_runs skips a step on later passes', async () => {
    const flow: WorkflowDefinition = {
      name: 'first-pass-only',
      title: 'First Pass Only',
      scope: 'global',
      steps: [
        { kind: 'agent', id: 'implement', agent: 'engineer', input: ['inputs.prompt'] },
        { kind: 'script', id: 'style-baseline', command: 'lint --baseline', when: { maxRuns: 1 } },
        {
          kind: 'agent',
          id: 'review',
          agent: 'reviewer',
          input: [],
          onBlocking: { gotoStepId: 'implement', maxLoops: 2, then: 'fail' },
        },
      ],
    };
    const engine = new ScriptedEngine([
      [done({ files: 1 })],
      [done({ blocking: true, findings: ['bug'] })],
      [done({ files: 2 })],
      [done({ blocking: false })],
    ]);
    const { deps, events, scripts } = makeDeps(engine);
    const run = new WorkflowRun(flow, context, deps);
    await run.start();

    expect(run.currentStatus).toBe('completed');
    expect(scripts).toEqual(['lint --baseline']); // ran once, skipped on the loop pass
    const skipped = events.find((event) => event.type === 'step-skipped');
    expect(skipped).toMatchObject({
      stepId: 'style-baseline',
      reason: 'runs on the first pass only',
    });
  });

  it('run counts survive resume, so max_runs holds across restarts', async () => {
    const flow: WorkflowDefinition = {
      name: 'resume-runs',
      title: 'Resume Runs',
      scope: 'global',
      steps: [
        { kind: 'script', id: 'setup', command: 'do-setup', when: { maxRuns: 1 } },
        { kind: 'gate', gate: 'approve', id: 'approve', show: [], editable: false },
        {
          kind: 'agent',
          id: 'review',
          agent: 'reviewer',
          input: [],
          onBlocking: { gotoStepId: 'setup', maxLoops: 1, then: 'gate' },
        },
      ],
    };
    const first = makeDeps(new ScriptedEngine([]));
    const run = new WorkflowRun(flow, context, first.deps);
    await run.start(); // setup runs, gate opens
    expect(first.scripts).toEqual(['do-setup']);

    const second = makeDeps(new ScriptedEngine([[done({ blocking: true })]]));
    const resumed = WorkflowRun.resume(flow, context, second.deps, first.events);
    await resumed.resolveGate('approve', true);

    // review blocked → loop to setup → setup SKIPPED (already ran before the restart)
    expect(second.scripts).toEqual([]);
    expect(second.events.some((event) => event.type === 'step-skipped')).toBe(true);
  });
});
