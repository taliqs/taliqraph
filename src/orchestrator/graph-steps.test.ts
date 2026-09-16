import type { ConditionBranchStep } from '../definitions/workflow/workflow-step';
import type { WorkflowDefinition } from '../definitions/workflow/workflow-definition';
import { describe, expect, it } from 'vitest';
import type { RunEvent } from './run-event';
import { ScriptedEngine, context, done, makeDeps } from './test-harness';
import type { ScriptRunSpec } from './workflow-run';
import { WorkflowRun } from './workflow-run';

describe('graph steps', () => {
  const conditionWorkflow: WorkflowDefinition = {
    name: 'branchy',
    title: 'Branchy',
    scope: 'global',
    steps: [
      { kind: 'agent', id: 'scout', agent: 'scout', input: ['inputs.prompt'], output: 'findings' },
      {
        kind: 'condition',
        id: 'confident',
        path: 'findings.confidence',
        compare: { op: 'gte', value: 0.8 },
        then: { kind: 'goto', stepId: 'fix' },
        else: { kind: 'goto', stepId: 'done-early' },
      },
      { kind: 'agent', id: 'done-early', agent: 'style', input: [] },
      { kind: 'agent', id: 'fix', agent: 'fixer', input: ['findings'] },
    ],
  };

  it('condition jumps on a true comparison and records the branch', async () => {
    const engine = new ScriptedEngine([
      [done({ confidence: 0.92 })],
      [done({ fixed: true })],
      [done({ styled: true })], // done-early runs AFTER fix (fall-through order)
    ]);
    const { deps, events } = makeDeps(engine);
    const run = new WorkflowRun(conditionWorkflow, context, deps);
    await run.start();
    expect(run.currentStatus).toBe('completed');
    const branch = events.find((event) => event.type === 'condition-evaluated');
    expect(branch).toMatchObject({ stepId: 'confident', result: true, to: 'fix' });
    // fix ran right after the jump
    const started = events
      .filter((event) => event.type === 'step-started')
      .map((event) => (event.type === 'step-started' ? event.stepId : ''));
    expect(started[1]).toBe('fix');
  });

  it('condition falls to else on a false comparison', async () => {
    const engine = new ScriptedEngine([
      [done({ confidence: 0.3 })],
      [done({ styled: true })],
      [done({ fixed: true })],
    ]);
    const { deps, events } = makeDeps(engine);
    const run = new WorkflowRun(conditionWorkflow, context, deps);
    await run.start();
    const branch = events.find((event) => event.type === 'condition-evaluated');
    expect(branch).toMatchObject({ result: false, to: 'done-early' });
  });

  it('a condition with an embedded then-chain runs both steps and merges their outputs downstream', async () => {
    const workflow: WorkflowDefinition = {
      name: 'embedded-then',
      title: 'Embedded then',
      scope: 'global',
      steps: [
        { kind: 'agent', id: 'scout', agent: 'scout', input: [], output: 'findings' },
        {
          kind: 'condition',
          id: 'risky',
          path: 'findings.risky',
          compare: { op: 'equals', value: true },
          then: {
            kind: 'steps',
            steps: [
              { kind: 'agent', id: 'extra-review', agent: 'bugs', input: [], output: 'extra' },
              { kind: 'agent', id: 'notify-agent', agent: 'style', input: ['extra'] },
            ],
          },
        },
        { kind: 'agent', id: 'wrap', agent: 'fixer', input: ['extra'], output: 'result' },
      ],
    };
    const engine = new ScriptedEngine([
      [done({ risky: true })],
      [done({ found: 'x' })],
      [done({ notified: true })],
      [done({ ok: true })],
    ]);
    const { deps, events } = makeDeps(engine);
    const run = new WorkflowRun(workflow, context, deps);
    await run.start();
    expect(run.currentStatus).toBe('completed');
    // both branch steps ran, scoped under the condition's id (the condition
    // itself never gets a step-started - only condition-evaluated marks it)
    const started = events
      .filter((event) => event.type === 'step-started')
      .map((event) => (event.type === 'step-started' ? event.stepId : ''));
    expect(started).toEqual(['scout', 'risky/extra-review', 'risky/notify-agent', 'wrap']);
    // the branch's inner output reached a step OUTSIDE the condition, like an ordinary sibling
    expect(engine.specs[2]?.userMessage).toContain('x'); // notify-agent read 'extra'
    expect(engine.specs[3]?.userMessage).toContain('x'); // wrap read 'extra' too
    expect(run.collectedOutputs()['extra']).toEqual({ found: 'x' });
  });

  it('an empty else branch just falls through to the next step', async () => {
    const workflow: WorkflowDefinition = {
      name: 'empty-else',
      title: 'Empty else',
      scope: 'global',
      steps: [
        { kind: 'agent', id: 'scout', agent: 'scout', input: [], output: 'findings' },
        {
          kind: 'condition',
          id: 'risky',
          path: 'findings.risky',
          compare: { op: 'equals', value: true },
          then: { kind: 'steps', steps: [] },
        },
        { kind: 'agent', id: 'wrap', agent: 'fixer', input: [], output: 'result' },
      ],
    };
    const engine = new ScriptedEngine([[done({ risky: false })], [done({ ok: true })]]);
    const { deps, events } = makeDeps(engine);
    const run = new WorkflowRun(workflow, context, deps);
    await run.start();
    expect(run.currentStatus).toBe('completed');
    const started = events
      .filter((event) => event.type === 'step-started')
      .map((event) => (event.type === 'step-started' ? event.stepId : ''));
    expect(started).toEqual(['scout', 'wrap']);
  });

  it('a failing condition branch fails the run, not just the step', async () => {
    const workflow: WorkflowDefinition = {
      name: 'branch-fails',
      title: 'Branch fails',
      scope: 'global',
      steps: [
        {
          kind: 'condition',
          id: 'gate',
          path: 'run',
          compare: { op: 'truthy' },
          then: {
            kind: 'steps',
            steps: [{ kind: 'agent', id: 'boom', agent: 'no-such-agent', input: [] }],
          },
        },
      ],
    };
    const { deps, events } = makeDeps(new ScriptedEngine([]));
    const run = new WorkflowRun(workflow, context, deps);
    await run.start();
    expect(run.currentStatus).toBe('failed');
    expect(events.some((event) => event.type === 'run-failed')).toBe(true);
  });

  it('resuming a condition interrupted mid-branch re-enters it and reruns the branch', async () => {
    const workflow: WorkflowDefinition = {
      name: 'resume-branch',
      title: 'Resume branch',
      scope: 'global',
      steps: [
        {
          kind: 'condition',
          id: 'check',
          path: 'run',
          compare: { op: 'truthy' },
          then: {
            kind: 'steps',
            steps: [
              { kind: 'agent', id: 'first', agent: 'bugs', input: [], output: 'first' },
              { kind: 'agent', id: 'second', agent: 'style', input: ['first'] },
            ],
          },
        },
      ],
    };
    // Simulate a crash after 'first' completed but mid-way through 'second' -
    // the persisted log has 'first's own completion but nothing for 'second'
    // or the condition itself.
    const priorEvents: RunEvent[] = [
      { type: 'run-started', workflowName: 'resume-branch' },
      { type: 'step-started', stepId: 'check', stepKind: 'condition', attempt: 1 },
      { type: 'condition-evaluated', stepId: 'check', path: 'run', result: true },
      { type: 'step-started', stepId: 'check/first', stepKind: 'agent', attempt: 1 },
      { type: 'step-completed', stepId: 'check/first', report: { found: 'x' } },
      { type: 'step-started', stepId: 'check/second', stepKind: 'agent', attempt: 1 },
    ];
    // Resume reruns the WHOLE branch from its first step, not just the
    // unfinished tail: branch steps aren't gate-able, so the interrupted unit
    // of work is the branch. Both scripts get consumed on rerun.
    const engine = new ScriptedEngine([[done({ found: 'y' })], [done({ restarted: true })]]);
    const { deps } = makeDeps(engine);
    const resumed = WorkflowRun.resume(workflow, context, deps, [
      ...priorEvents,
      { type: 'run-resumed' },
    ]);
    expect(resumed.currentStatus).toBe('running');
    await resumed.continueRun();
    expect(resumed.currentStatus).toBe('completed');
    expect(engine.sessions).toHaveLength(2);
  });

  const gatedLane: WorkflowDefinition = {
    name: 'gated-lane',
    title: 'Gated lane',
    scope: 'global',
    steps: [
      { kind: 'agent', id: 'scout', agent: 'scout', input: [], output: 'findings' },
      {
        kind: 'condition',
        id: 'risky',
        path: 'findings.risky',
        compare: { op: 'equals', value: true },
        then: {
          kind: 'steps',
          steps: [
            { kind: 'agent', id: 'deep-dive', agent: 'bugs', input: ['findings'], output: 'deep' },
            { kind: 'gate', gate: 'approve', id: 'escalate', show: ['deep'], editable: false },
          ],
        },
      },
      { kind: 'agent', id: 'wrap', agent: 'fixer', input: ['deep'], output: 'result' },
    ],
  };

  it("a gate inside a condition's lane pauses the run as '<condition>/<gate>'; resolving it carries on", async () => {
    const engine = new ScriptedEngine([
      [done({ risky: true })],
      [done({ found: 'x' })],
      [done({ ok: true })],
    ]);
    const { deps, events } = makeDeps(engine);
    const run = new WorkflowRun(gatedLane, context, deps);
    await run.start();
    expect(run.currentStatus).toBe('waiting-gate');
    expect(run.waitingStep()).toEqual({ kind: 'gate', stepId: 'risky/escalate' });
    expect(
      events.some((event) => event.type === 'gate-opened' && event.stepId === 'risky/escalate'),
    ).toBe(true);
    // the lane saw the pipeline's upstream output - deep-dive read 'findings' like any sibling would
    expect(engine.specs[1]?.userMessage).toContain('risky');
    await run.resolveGate('risky/escalate', true);
    expect(run.currentStatus).toBe('completed');
    expect(run.collectedOutputs()['deep']).toEqual({ found: 'x' });
    expect(engine.specs[2]?.userMessage).toContain('x'); // wrap read the lane's output
  });

  it('a gate-paused condition lane survives a restart: resolving it after resume finishes the run', async () => {
    const priorEvents: RunEvent[] = [
      { type: 'run-started', workflowName: 'gated-lane' },
      { type: 'step-started', stepId: 'scout', stepKind: 'agent', attempt: 1 },
      { type: 'step-completed', stepId: 'scout', report: { risky: true } },
      { type: 'condition-evaluated', stepId: 'risky', path: 'findings.risky', result: true },
      { type: 'step-started', stepId: 'risky/deep-dive', stepKind: 'agent', attempt: 1 },
      { type: 'step-completed', stepId: 'risky/deep-dive', report: { found: 'x' } },
      { type: 'gate-opened', stepId: 'risky/escalate', show: ['deep'] },
      { type: 'run-resumed' },
    ];
    const engine = new ScriptedEngine([[done({ ok: true })]]); // only 'wrap' is still to run
    const { deps } = makeDeps(engine);
    const resumed = WorkflowRun.resume(gatedLane, context, deps, priorEvents);
    expect(resumed.currentStatus).toBe('waiting-gate');
    expect(resumed.waitingStep()).toEqual({ kind: 'gate', stepId: 'risky/escalate' });
    await resumed.continueRun(); // a no-op while the gate is open
    expect(resumed.currentStatus).toBe('waiting-gate');
    await resumed.resolveGate('risky/escalate', true);
    expect(resumed.currentStatus).toBe('completed');
    expect(engine.sessions).toHaveLength(1);
    expect(engine.specs[0]?.userMessage).toContain('x'); // wrap read 'deep', recorded before the crash
  });

  it('a top-level goto jumps back until its cap, then falls through', async () => {
    const workflow: WorkflowDefinition = {
      name: 'retry',
      title: 'Retry',
      scope: 'global',
      steps: [
        { kind: 'agent', id: 'fix', agent: 'fixer', input: [], output: 'result' },
        { kind: 'goto', id: 'retry', targetStepId: 'fix', maxLoops: 2 },
        { kind: 'agent', id: 'wrap', agent: 'style', input: [] },
      ],
    };
    const engine = new ScriptedEngine([
      [done({ n: 1 })],
      [done({ n: 2 })],
      [done({ n: 3 })],
      [done({ ok: true })],
    ]);
    const { deps, events } = makeDeps(engine);
    const run = new WorkflowRun(workflow, context, deps);
    await run.start();
    expect(run.currentStatus).toBe('completed');
    // fix ran 3 times (once, then two jumps), then the goto fell through to wrap
    expect(engine.sessions).toHaveLength(4);
    const jumps = events.filter((event) => event.type === 'loop-back' && event.reason === 'goto');
    expect(jumps.map((event) => (event.type === 'loop-back' ? event.iteration : 0))).toEqual([
      1, 2,
    ]);
    expect(events.some((event) => event.type === 'step-skipped' && event.stepId === 'retry')).toBe(
      true,
    );
  });

  it("a goto inside a condition's lane jumps to an enclosing step, and its count survives the lane being re-entered", async () => {
    const workflow: WorkflowDefinition = {
      name: 'lane-retry',
      title: 'Lane retry',
      scope: 'global',
      steps: [
        { kind: 'agent', id: 'scout', agent: 'scout', input: [], output: 'findings' },
        {
          kind: 'condition',
          id: 'risky',
          path: 'findings.risky',
          compare: { op: 'equals', value: true },
          then: {
            kind: 'steps',
            steps: [{ kind: 'goto', id: 'retry', targetStepId: 'scout', maxLoops: 1 }],
          },
        },
        { kind: 'agent', id: 'wrap', agent: 'style', input: [] },
      ],
    };
    const engine = new ScriptedEngine([
      [done({ risky: true })],
      [done({ risky: true })],
      [done({ ok: true })],
    ]);
    const { deps, events } = makeDeps(engine);
    const run = new WorkflowRun(workflow, context, deps);
    await run.start();
    expect(run.currentStatus).toBe('completed');
    // scout, jump, scout again (still risky) - the single jump is spent, so the lane falls through to wrap
    expect(engine.sessions).toHaveLength(3);
    const jumps = events.filter((event) => event.type === 'loop-back' && event.reason === 'goto');
    expect(jumps).toHaveLength(1);
    expect(jumps[0]?.type === 'loop-back' && jumps[0]).toMatchObject({
      fromStepId: 'risky/retry',
      toStepId: 'scout',
    });
    expect(
      events.some((event) => event.type === 'step-skipped' && event.stepId === 'risky/retry'),
    ).toBe(true);
  });

  it("finish and fail inside a condition's lane end the WHOLE run, not just the lane", async () => {
    const base = (lane: ConditionBranchStep[]): WorkflowDefinition => ({
      name: 'ender',
      title: 'Ender',
      scope: 'global',
      steps: [
        { kind: 'agent', id: 'scout', agent: 'scout', input: [], output: 'findings' },
        {
          kind: 'condition',
          id: 'risky',
          path: 'findings.risky',
          compare: { op: 'equals', value: true },
          then: { kind: 'steps', steps: lane },
        },
        { kind: 'agent', id: 'wrap', agent: 'style', input: [] },
      ],
    });

    const finishing = new ScriptedEngine([[done({ risky: true })], [done({ never: true })]]);
    const finished = makeDeps(finishing);
    const finishRun = new WorkflowRun(
      base([{ kind: 'finish', id: 'stop' }]),
      context,
      finished.deps,
    );
    await finishRun.start();
    expect(finishRun.currentStatus).toBe('completed');
    expect(finishing.sessions).toHaveLength(1); // wrap never ran
    expect(finished.events.some((event) => event.type === 'run-completed')).toBe(true);

    const failing = new ScriptedEngine([[done({ risky: true })], [done({ never: true })]]);
    const failed = makeDeps(failing);
    const failRun = new WorkflowRun(
      base([{ kind: 'fail', id: 'bail', message: 'still red' }]),
      context,
      failed.deps,
    );
    await failRun.start();
    expect(failRun.currentStatus).toBe('failed');
    expect(failing.sessions).toHaveLength(1);
    expect(failed.events.find((event) => event.type === 'run-failed')).toMatchObject({
      message: 'still red',
    });
  });

  it('every control step writes an output readable downstream by its id - condition, while, gate, script', async () => {
    const workflow: WorkflowDefinition = {
      name: 'outputs-everywhere',
      title: 'Outputs everywhere',
      scope: 'global',
      steps: [
        { kind: 'agent', id: 'scout', agent: 'scout', input: [], output: 'findings' },
        {
          kind: 'condition',
          id: 'risky',
          path: 'findings.risky',
          compare: { op: 'equals', value: true },
          then: { kind: 'steps', steps: [] },
        },
        {
          kind: 'while',
          id: 'again',
          path: 'findings.risky',
          compare: { op: 'equals', value: false },
          gotoStepId: 'scout',
          maxLoops: 2,
        },
        {
          kind: 'gate',
          gate: 'approve',
          id: 'ok',
          show: ['findings.summary', 'risky', 'diff'],
          editable: false,
        },
        { kind: 'script', id: 'ship', command: 'github-create-pr' },
        // reads a field of the condition's output, the gate's outcome, the script's report, and the alias/id pair
        {
          kind: 'agent',
          id: 'wrap',
          agent: 'style',
          input: [
            'risky.result',
            'risky.branch',
            'ok.approved',
            'ship.url',
            'scout.summary',
            'findings.summary',
          ],
        },
      ],
    };
    const engine = new ScriptedEngine([
      [done({ risky: true, summary: 'two leaks' })],
      [done({ ok: true })],
    ]);
    const { deps, events } = makeDeps(engine);
    const run = new WorkflowRun(workflow, context, {
      ...deps,
      runScript: () =>
        Promise.resolve({
          exitCode: 0,
          stdout: JSON.stringify({ url: 'https://github.com/x/pull/1' }),
          stderr: '',
        }),
    });
    await run.start();
    expect(run.currentStatus).toBe('waiting-gate');
    // the gate carries what it shows, resolved when it opened (diff is fetched live by the UI)
    const opened = events.find((event) => event.type === 'gate-opened' && event.stepId === 'ok');
    expect(opened?.type === 'gate-opened' && opened.shown).toEqual({
      'findings.summary': 'two leaks',
      risky: { path: 'findings.risky', value: true, result: true, branch: 'then' },
    });
    await run.resolveGate('ok', true, 'ship it');
    expect(run.currentStatus).toBe('completed');

    const outputs = run.collectedOutputs();
    expect(outputs['risky']).toEqual({
      path: 'findings.risky',
      value: true,
      result: true,
      branch: 'then',
    });
    expect(outputs['again']).toEqual({
      path: 'findings.risky',
      value: true,
      looped: false,
      iteration: 0,
      maxLoops: 2,
    });
    expect(outputs['ok']).toEqual({ approved: true, note: 'ship it', rejections: 0 });
    expect(outputs['ship']).toEqual({ url: 'https://github.com/x/pull/1' });
    expect(outputs['scout']).toBe(outputs['findings']); // id and alias are the same report
    // and the agent's message resolved every dotted reference
    const message = engine.specs[1]?.userMessage ?? '';
    expect(message).toContain('# risky.result\n```json\ntrue\n```');
    expect(message).toContain('# risky.branch\n```json\n"then"\n```');
    expect(message).toContain('# ok.approved\n```json\ntrue\n```');
    expect(message).toContain('# ship.url\n```json\n"https://github.com/x/pull/1"\n```');
    expect(message).toContain('# scout.summary\n```json\n"two leaks"\n```');
    expect(message).toContain('# findings.summary\n```json\n"two leaks"\n```');
  });

  it('a script step runs its definition when the name matches, with its bound inputs resolved; the last JSON line (or the report file) is its output', async () => {
    const workflow: WorkflowDefinition = {
      name: 'scripted',
      title: 'Scripted',
      scope: 'global',
      steps: [
        { kind: 'agent', id: 'scout', agent: 'scout', input: [], output: 'findings' },
        {
          kind: 'script',
          id: 'test',
          command: 'run-tests',
          input: ['findings', 'inputs.prompt', 'findings.risky', 'nope'],
        },
        { kind: 'script', id: 'lint', command: 'pnpm lint', input: ['test.passed'] },
        { kind: 'agent', id: 'wrap', agent: 'style', input: ['test.passed', 'lint'] },
      ],
    };
    const runTests = {
      name: 'run-tests',
      description: 'runs the tests',
      run: 'node run.mjs',
      inputs: [{ name: 'findings', required: true }],
      timeoutMinutes: 5,
      scope: 'global' as const,
      dir: '/scripts/run-tests',
    };
    const seen: ScriptRunSpec[] = [];
    const engine = new ScriptedEngine([
      [done({ risky: true, summary: 'two leaks' })],
      [done({ ok: true })],
    ]);
    const { deps } = makeDeps(engine);
    const run = new WorkflowRun(workflow, context, {
      ...deps,
      resolveScript: (name) => (name === 'run-tests' ? runTests : undefined),
      runScript: (spec) => {
        seen.push(spec);
        return Promise.resolve(
          spec.definition
            ? { exitCode: 0, stdout: 'running 3 tests…\n{"passed": 3, "failed": 0}\n', stderr: '' }
            : { exitCode: 0, stdout: '{"ignored": true}', stderr: '', report: { fromFile: true } },
        );
      },
    });
    await run.start();
    expect(run.currentStatus).toBe('completed');

    // the definition, its timeout, and the inputs - positional: `args` in the step's order, the first slot also
    // under the script's parameter name, the rest under their references; inputs always the declared ones; unknown → null
    const findings = { risky: true, summary: 'two leaks' };
    expect(seen[0]?.definition?.name).toBe('run-tests');
    expect(seen[0]?.command).toBeUndefined();
    expect(seen[0]?.timeoutMs).toBe(5 * 60_000);
    expect(seen[0]?.inputs).toEqual({
      inputs: context.inputs,
      args: [findings, 'Fix the license retry loop.', true, null],
      findings,
      'inputs.prompt': 'Fix the license retry loop.',
      'findings.risky': true,
      nope: null,
    });
    // an inline command stays a command, with the default timeout and its inputs under their references
    expect(seen[1]?.command).toBe('pnpm lint');
    expect(seen[1]?.definition).toBeUndefined();
    expect(seen[1]?.timeoutMs).toBe(10 * 60_000);
    expect(seen[1]?.inputs).toEqual({ inputs: context.inputs, args: [3], 'test.passed': 3 });

    const outputs = run.collectedOutputs();
    expect(outputs['test']).toEqual({ passed: 3, failed: 0 }); // the last JSON line, not the log line
    expect(outputs['lint']).toEqual({ fromFile: true }); // the report file wins over stdout
    expect(engine.specs[1]?.userMessage).toContain('# test.passed\n```json\n3\n```');
  });

  it('`<condition>.output` is the ran side’s headline - its last step’s report - live and on replay', async () => {
    const workflow: WorkflowDefinition = {
      name: 'headline',
      title: 'Headline',
      scope: 'global',
      steps: [
        { kind: 'agent', id: 'scout', agent: 'scout', input: [], output: 'findings' },
        {
          kind: 'condition',
          id: 'risky',
          path: 'findings.risky',
          compare: { op: 'equals', value: true },
          then: { kind: 'steps', steps: [{ kind: 'agent', id: 'deep', agent: 'bugs', input: [] }] },
          else: {
            kind: 'steps',
            steps: [{ kind: 'agent', id: 'skim', agent: 'style', input: [] }],
          },
        },
        {
          // a lane ending in a gate: its headline is the gate's outcome
          kind: 'condition',
          id: 'checked',
          path: 'findings.risky',
          compare: { op: 'equals', value: true },
          then: {
            kind: 'steps',
            steps: [
              { kind: 'gate', gate: 'approve', id: 'escalate', show: ['deep'], editable: false },
            ],
          },
        },
        {
          kind: 'agent',
          id: 'wrap',
          agent: 'style',
          input: ['risky.output.count', 'checked.output.approved'],
        },
      ],
    };
    const engine = new ScriptedEngine([
      [done({ risky: true })],
      [done({ count: 2, notes: 'two leaks' })],
      [done({ ok: true })],
    ]);
    const { deps, events } = makeDeps(engine);
    const run = new WorkflowRun(workflow, context, deps);
    await run.start();
    expect(run.currentStatus).toBe('waiting-gate');
    await run.resolveGate('checked/escalate', true, 'fine');
    expect(run.currentStatus).toBe('completed');

    const outputs = run.collectedOutputs();
    expect(outputs['risky']).toEqual({
      path: 'findings.risky',
      value: true,
      result: true,
      branch: 'then',
      output: { count: 2, notes: 'two leaks' },
    });
    expect(outputs['checked']).toEqual({
      path: 'findings.risky',
      value: true,
      result: true,
      branch: 'then',
      output: { approved: true, note: 'fine', rejections: 0 },
    });
    const message = engine.specs[2]?.userMessage ?? '';
    expect(message).toContain('# risky.output.count\n```json\n2\n```');
    expect(message).toContain('# checked.output.approved\n```json\ntrue\n```');

    // the same log, replayed, rebuilds both exactly
    const replayed = WorkflowRun.resume(workflow, context, makeDeps(new ScriptedEngine([])).deps, [
      ...events,
      { type: 'run-resumed' },
    ]);
    expect(replayed.collectedOutputs()['risky']).toEqual(outputs['risky']);
    expect(replayed.collectedOutputs()['checked']).toEqual(outputs['checked']);
  });

  it('control-step outputs are rebuilt from the log on resume, exactly as they were live', async () => {
    const workflow: WorkflowDefinition = {
      name: 'replayed-outputs',
      title: 'Replayed outputs',
      scope: 'global',
      steps: [
        { kind: 'agent', id: 'scout', agent: 'scout', input: [], output: 'findings' },
        {
          kind: 'while',
          id: 'again',
          path: 'findings.risky',
          compare: { op: 'equals', value: true },
          gotoStepId: 'scout',
          maxLoops: 1,
        },
        {
          kind: 'condition',
          id: 'risky',
          path: 'findings.risky',
          compare: { op: 'equals', value: true },
          then: { kind: 'goto', stepId: 'ok' },
        },
        { kind: 'gate', gate: 'approve', id: 'ok', show: [], editable: false },
        { kind: 'agent', id: 'wrap', agent: 'style', input: ['risky.branch', 'again.iteration'] },
      ],
    };
    const priorEvents: RunEvent[] = [
      { type: 'run-started', workflowName: 'replayed-outputs' },
      { type: 'step-started', stepId: 'scout', stepKind: 'agent', attempt: 1 },
      { type: 'step-completed', stepId: 'scout', report: { risky: true } },
      {
        type: 'condition-evaluated',
        stepId: 'again',
        path: 'findings.risky',
        value: true,
        result: true,
        loop: true,
      },
      { type: 'loop-back', fromStepId: 'again', toStepId: 'scout', iteration: 1, reason: 'while' },
      { type: 'step-started', stepId: 'scout', stepKind: 'agent', attempt: 1 },
      { type: 'step-completed', stepId: 'scout', report: { risky: true } },
      {
        type: 'condition-evaluated',
        stepId: 'again',
        path: 'findings.risky',
        value: true,
        result: false,
        loop: true,
      },
      {
        type: 'condition-evaluated',
        stepId: 'risky',
        path: 'findings.risky',
        value: true,
        result: true,
        to: 'ok',
      },
      { type: 'gate-opened', stepId: 'ok', show: [] },
      { type: 'gate-resolved', stepId: 'ok', approved: false, note: 'not yet' },
      {
        type: 'loop-back',
        fromStepId: 'ok',
        toStepId: 'scout',
        iteration: 1,
        reason: 'gate-rejected',
        note: 'not yet',
      },
      { type: 'step-started', stepId: 'scout', stepKind: 'agent', attempt: 1 },
      { type: 'step-completed', stepId: 'scout', report: { risky: true } },
      {
        type: 'condition-evaluated',
        stepId: 'again',
        path: 'findings.risky',
        value: true,
        result: false,
        loop: true,
      },
      {
        type: 'condition-evaluated',
        stepId: 'risky',
        path: 'findings.risky',
        value: true,
        result: true,
        to: 'ok',
      },
      { type: 'gate-opened', stepId: 'ok', show: [] },
      { type: 'run-resumed' },
    ];
    const engine = new ScriptedEngine([[done({ ok: true })]]);
    const { deps } = makeDeps(engine);
    const resumed = WorkflowRun.resume(workflow, context, deps, priorEvents);
    expect(resumed.currentStatus).toBe('waiting-gate');
    const outputs = resumed.collectedOutputs();
    expect(outputs['again']).toEqual({
      path: 'findings.risky',
      value: true,
      looped: false,
      iteration: 1,
      maxLoops: 1,
    });
    expect(outputs['risky']).toEqual({
      path: 'findings.risky',
      value: true,
      result: true,
      branch: 'then',
      jumpedTo: 'ok',
    });
    expect(outputs['ok']).toEqual({ approved: false, note: 'not yet', rejections: 1 });
    await resumed.resolveGate('ok', true);
    expect(resumed.currentStatus).toBe('completed');
    expect(resumed.collectedOutputs()['ok']).toEqual({ approved: true, note: '', rejections: 1 });
    expect(engine.specs[0]?.userMessage).toContain('# again.iteration\n```json\n1\n```');
  });

  it('a sub-workflow reads the outputs the pipeline produced before it, and hands back only its own', async () => {
    const inner: WorkflowDefinition = {
      name: 'polisher',
      title: 'Polisher',
      scope: 'global',
      steps: [
        {
          kind: 'agent',
          id: 'polish',
          agent: 'style',
          input: ['findings.summary'],
          output: 'polished',
        },
      ],
    };
    const workflow: WorkflowDefinition = {
      name: 'outer',
      title: 'Outer',
      scope: 'global',
      steps: [
        { kind: 'agent', id: 'scout', agent: 'scout', input: [], output: 'findings' },
        { kind: 'workflow', id: 'review', workflow: 'polisher' },
      ],
    };
    const engine = new ScriptedEngine([
      [done({ summary: 'two leaks' })],
      [done({ text: 'shiny' })],
    ]);
    const { deps } = makeDeps(engine);
    const run = new WorkflowRun(workflow, context, { ...deps, resolveWorkflow: () => inner });
    await run.start();
    expect(run.currentStatus).toBe('completed');
    expect(engine.specs[1]?.userMessage).toContain('# findings.summary\n```json\n"two leaks"\n```');
    // the parent's own outputs don't echo back under the sub-workflow's id
    expect(run.collectedOutputs()['review']).toEqual({
      polish: { text: 'shiny' },
      polished: { text: 'shiny' },
    });
  });

  it("condition/while can nest inside another condition's branch", async () => {
    const workflow: WorkflowDefinition = {
      name: 'nested-condition',
      title: 'Nested condition',
      scope: 'global',
      steps: [
        {
          kind: 'condition',
          id: 'outer',
          path: 'run',
          compare: { op: 'truthy' },
          then: {
            kind: 'steps',
            steps: [
              {
                kind: 'condition',
                id: 'inner',
                path: 'run',
                compare: { op: 'truthy' },
                then: {
                  kind: 'steps',
                  steps: [{ kind: 'agent', id: 'deep', agent: 'bugs', input: [] }],
                },
              },
            ],
          },
        },
      ],
    };
    const { deps, events } = makeDeps(new ScriptedEngine([[done({ found: true })]]));
    const run = new WorkflowRun(workflow, context, deps);
    await run.start();
    expect(run.currentStatus).toBe('completed');
    expect(
      events.some((event) => event.type === 'step-started' && event.stepId === 'outer/inner/deep'),
    ).toBe(true);
  });

  it('while loops back until the comparison breaks or maxLoops is hit', async () => {
    const workflow: WorkflowDefinition = {
      name: 'loopy',
      title: 'Loopy',
      scope: 'global',
      steps: [
        { kind: 'agent', id: 'fix', agent: 'fixer', input: [], output: 'result' },
        {
          kind: 'while',
          id: 'again',
          path: 'result.blocking',
          compare: { op: 'equals', value: true },
          gotoStepId: 'fix',
          maxLoops: 5,
        },
      ],
    };
    const engine = new ScriptedEngine([
      [done({ blocking: true })],
      [done({ blocking: true })],
      [done({ blocking: false })],
    ]);
    const { deps, events } = makeDeps(engine);
    const run = new WorkflowRun(workflow, context, deps);
    await run.start();
    expect(run.currentStatus).toBe('completed');
    const loops = events.filter((event) => event.type === 'loop-back' && event.reason === 'while');
    expect(loops).toHaveLength(2);
    expect(engine.specs).toHaveLength(3);
  });

  it('parallel fans out concurrently, joins outputs, and prefixes child events', async () => {
    const workflow: WorkflowDefinition = {
      name: 'fanout',
      title: 'Fanout',
      scope: 'global',
      steps: [
        {
          kind: 'parallel',
          id: 'reviews',
          children: [
            [
              {
                kind: 'agent',
                id: 'bugs',
                agent: 'bugs',
                input: ['inputs.prompt'],
                output: 'bugs',
              },
            ],
            [
              {
                kind: 'agent',
                id: 'style',
                agent: 'style',
                input: ['inputs.prompt'],
                output: 'style',
              },
            ],
          ],
        },
        { kind: 'agent', id: 'fix', agent: 'fixer', input: ['bugs', 'style'], output: 'result' },
      ],
    };
    const engine = new ScriptedEngine([
      [done({ blocking: false, list: ['b1'] })],
      [done({ notes: ['s1'] })],
      [done({ fixed: true })],
    ]);
    const { deps, events } = makeDeps(engine);
    const run = new WorkflowRun(workflow, context, deps);
    await run.start();
    expect(run.currentStatus).toBe('completed');
    const childStarts = events
      .filter((event) => event.type === 'step-started' && event.stepId.includes('/'))
      .map((event) => (event.type === 'step-started' ? event.stepId : ''));
    expect(childStarts.sort()).toEqual(['reviews/bugs', 'reviews/style']);
    // the joined outputs reached the downstream step
    expect(engine.specs[2]?.userMessage).toContain('b1');
    expect(engine.specs[2]?.userMessage).toContain('s1');
    expect(run.collectedOutputs()['reviews']).toEqual({
      bugs: { blocking: false, list: ['b1'] },
      style: { notes: ['s1'] },
    });
  });

  it('a parallel branch can be a multi-step chain, running concurrently with a single-step branch', async () => {
    const workflow: WorkflowDefinition = {
      name: 'chained-fork',
      title: 'Chained fork',
      scope: 'global',
      steps: [
        {
          kind: 'parallel',
          id: 'checks',
          children: [
            [{ kind: 'agent', id: 'solo', agent: 'bugs', input: [], output: 'solo' }],
            [
              { kind: 'agent', id: 'chain-a', agent: 'style', input: [], output: 'chain-a' },
              { kind: 'agent', id: 'chain-b', agent: 'fixer', input: ['chain-a'] },
            ],
          ],
        },
        { kind: 'agent', id: 'wrap', agent: 'scout', input: ['solo', 'chain-a'], output: 'result' },
      ],
    };
    const engine = new ScriptedEngine([
      [done({ found: 'solo-result' })],
      [done({ found: 'chain-a-result' })],
      [done({ found: 'chain-b-result' })],
      [done({ ok: true })],
    ]);
    const { deps, events } = makeDeps(engine);
    const run = new WorkflowRun(workflow, context, deps);
    await run.start();
    expect(run.currentStatus).toBe('completed');
    const childStarts = events
      .filter((event) => event.type === 'step-started' && event.stepId.includes('/'))
      .map((event) => (event.type === 'step-started' ? event.stepId : ''));
    expect(childStarts.sort()).toEqual(['checks/chain-a', 'checks/chain-b', 'checks/solo']);
    // the fork's aggregate report keys each branch by its FIRST step's id;
    // a chain branch's value is its LAST step's own output
    expect(run.collectedOutputs()['checks']).toEqual({
      solo: { found: 'solo-result' },
      'chain-a': { found: 'chain-b-result' },
    });
    // every inner step's own output stays readable by its own bare name too
    expect(run.collectedOutputs()['chain-a']).toEqual({ found: 'chain-a-result' });
    expect(engine.specs[2]?.userMessage).toContain('chain-a-result'); // chain-b read chain-a's output
  });

  it('a failing branch in a chain fork kills the run under the default on_fail: fail policy', async () => {
    const workflow: WorkflowDefinition = {
      name: 'chain-fails',
      title: 'Chain fails',
      scope: 'global',
      steps: [
        {
          kind: 'parallel',
          id: 'checks',
          children: [
            [{ kind: 'agent', id: 'ok', agent: 'bugs', input: [] }],
            [
              { kind: 'agent', id: 'boom', agent: 'no-such-agent', input: [] },
              { kind: 'agent', id: 'never', agent: 'style', input: [] },
            ],
          ],
        },
      ],
    };
    const { deps, events } = makeDeps(new ScriptedEngine([[done({ ok: true })]]));
    const run = new WorkflowRun(workflow, context, deps);
    await run.start();
    expect(run.currentStatus).toBe('failed');
    expect(events.some((event) => event.type === 'run-failed')).toBe(true);
  });

  it('a fork branch can itself be a condition, scoped to that branch', async () => {
    const workflow: WorkflowDefinition = {
      name: 'fork-condition',
      title: 'Fork condition',
      scope: 'global',
      steps: [
        {
          kind: 'parallel',
          id: 'checks',
          children: [
            [{ kind: 'agent', id: 'solo', agent: 'bugs', input: [] }],
            [
              {
                kind: 'condition',
                id: 'gate',
                path: 'run',
                compare: { op: 'truthy' },
                then: {
                  kind: 'steps',
                  steps: [{ kind: 'agent', id: 'inner', agent: 'style', input: [] }],
                },
              },
            ],
          ],
        },
      ],
    };
    const { deps, events } = makeDeps(new ScriptedEngine([[done({ a: 1 })], [done({ b: 2 })]]));
    const run = new WorkflowRun(workflow, context, deps);
    await run.start();
    expect(run.currentStatus).toBe('completed');
    expect(
      events.some((event) => event.type === 'step-started' && event.stepId === 'checks/gate/inner'),
    ).toBe(true);
  });

  it('a fork with a chain branch resumes only the un-run branch, never re-spending on a finished one', async () => {
    const workflow: WorkflowDefinition = {
      name: 'resume-fork-chain',
      title: 'Resume fork chain',
      scope: 'global',
      steps: [
        {
          kind: 'parallel',
          id: 'checks',
          children: [
            [{ kind: 'agent', id: 'solo', agent: 'bugs', input: [], output: 'solo' }],
            [
              { kind: 'agent', id: 'chain-a', agent: 'style', input: [], output: 'chain-a' },
              { kind: 'agent', id: 'chain-b', agent: 'fixer', input: [] },
            ],
          ],
        },
      ],
    };
    // 'solo' fully finished before the crash; the chain branch never started.
    const priorEvents: RunEvent[] = [
      { type: 'run-started', workflowName: 'resume-fork-chain' },
      { type: 'step-started', stepId: 'checks', stepKind: 'parallel', attempt: 1 },
      { type: 'step-started', stepId: 'checks/solo', stepKind: 'agent', attempt: 1 },
      { type: 'step-completed', stepId: 'checks/solo', report: { found: 'solo-result' } },
    ];
    const engine = new ScriptedEngine([[done({ found: 'a' })], [done({ found: 'b' })]]);
    const { deps } = makeDeps(engine);
    const resumed = WorkflowRun.resume(workflow, context, deps, [
      ...priorEvents,
      { type: 'run-resumed' },
    ]);
    await resumed.continueRun();
    expect(resumed.currentStatus).toBe('completed');
    // only the chain branch's two steps ran - 'solo' was never re-dispatched
    expect(engine.sessions).toHaveLength(2);
    expect(resumed.collectedOutputs()['checks']).toEqual({
      solo: { found: 'solo-result' },
      'chain-a': { found: 'b' },
    });
  });

  it('a fork runs script and agent branches together, namespacing results by branch id', async () => {
    const workflow: WorkflowDefinition = {
      name: 'mixed',
      title: 'Mixed',
      scope: 'global',
      steps: [
        {
          kind: 'parallel',
          id: 'checks',
          children: [
            [{ kind: 'agent', id: 'bugs', agent: 'bugs', input: ['inputs.prompt'] }],
            [{ kind: 'script', id: 'tests', command: 'run-tests' }],
          ],
        },
        { kind: 'agent', id: 'fix', agent: 'fixer', input: ['checks'], output: 'result' },
      ],
    };
    const engine = new ScriptedEngine([[done({ blocking: false })], [done({ fixed: true })]]);
    const { deps, events } = makeDeps(engine);
    const run = new WorkflowRun(workflow, context, {
      ...deps,
      runScript: () => Promise.resolve({ exitCode: 0, stdout: '{"passed": 12}', stderr: '' }),
    });
    await run.start();
    expect(run.currentStatus).toBe('completed');
    const childStarts = events
      .filter((event) => event.type === 'step-started' && event.stepId.includes('/'))
      .map((event) => (event.type === 'step-started' ? event.stepId : ''));
    expect(childStarts.sort()).toEqual(['checks/bugs', 'checks/tests']);
    expect(run.collectedOutputs()['checks']).toEqual({
      bugs: { blocking: false },
      tests: { passed: 12 },
    });
    // the downstream step received the whole namespaced report
    expect(engine.specs[1]?.userMessage).toContain('passed');
  });

  it('for_each fans out one agent per item and namespaces results by index', async () => {
    const workflow: WorkflowDefinition = {
      name: 'fan',
      title: 'Fan',
      scope: 'global',
      steps: [
        { kind: 'agent', id: 'review', agent: 'scout', input: ['inputs.prompt'], output: 'review' },
        {
          kind: 'foreach',
          id: 'fix-all',
          path: 'review.findings',
          itemName: 'finding',
          maxItems: 10,
          template: {
            kind: 'agent',
            id: 'item',
            agent: 'fixer',
            input: ['inputs.prompt', 'finding'],
          },
        },
        { kind: 'agent', id: 'summary', agent: 'style', input: ['fix-all'], output: 'result' },
      ],
    };
    const engine = new ScriptedEngine([
      [done({ findings: [{ file: 'a.ts' }, { file: 'b.ts' }, { file: 'c.ts' }] })],
      [done({ fixed: 'one' })],
      [done({ fixed: 'two' })],
      [done({ fixed: 'three' })],
      [done({ ok: true })],
    ]);
    const { deps, events } = makeDeps(engine);
    const run = new WorkflowRun(workflow, context, deps);
    await run.start();
    expect(run.currentStatus).toBe('completed');
    const childStarts = events
      .filter((event) => event.type === 'step-started' && event.stepId.startsWith('fix-all/'))
      .map((event) => (event.type === 'step-started' ? event.stepId : ''));
    expect(childStarts.sort()).toEqual(['fix-all/1', 'fix-all/2', 'fix-all/3']);
    expect(run.collectedOutputs()['fix-all']).toEqual({
      '1': { fixed: 'one' },
      '2': { fixed: 'two' },
      '3': { fixed: 'three' },
    });
    // each item agent saw ITS item under the declared name
    const fixerMessages = engine.specs.slice(1, 4).map((spec) => spec.userMessage);
    expect(fixerMessages.some((message) => message.includes('a.ts'))).toBe(true);
    expect(fixerMessages.some((message) => message.includes('c.ts'))).toBe(true);
    // the summary step received the namespaced composite
    expect(engine.specs[4]?.userMessage).toContain('two');
  });

  it('a resumed for_each re-runs only the items without recorded results', async () => {
    const workflow: WorkflowDefinition = {
      name: 'fan',
      title: 'Fan',
      scope: 'global',
      steps: [
        { kind: 'agent', id: 'review', agent: 'scout', input: [], output: 'review' },
        {
          kind: 'foreach',
          id: 'fix-all',
          path: 'review.findings',
          itemName: 'finding',
          maxItems: 10,
          template: { kind: 'agent', id: 'item', agent: 'fixer', input: ['finding'] },
        },
      ],
    };
    const priorEvents: RunEvent[] = [
      { type: 'run-started', workflowName: 'fan' },
      { type: 'step-started', stepId: 'review', stepKind: 'agent', attempt: 1 },
      { type: 'step-completed', stepId: 'review', report: { findings: ['x', 'y'] } },
      { type: 'step-started', stepId: 'fix-all', stepKind: 'foreach', attempt: 1 },
      { type: 'step-started', stepId: 'fix-all/1', stepKind: 'agent', attempt: 1 },
      { type: 'step-completed', stepId: 'fix-all/1', report: { fixed: 'x' } },
      { type: 'run-interrupted', reason: 'crash' },
      { type: 'run-resumed' },
    ];
    const engine = new ScriptedEngine([[done({ fixed: 'y' })]]); // ONLY item 2 runs
    const { deps } = makeDeps(engine);
    const run = WorkflowRun.resume(workflow, context, deps, priorEvents);
    await run.continueRun();
    expect(run.currentStatus).toBe('completed');
    expect(engine.specs).toHaveLength(1);
    expect(run.collectedOutputs()['fix-all']).toEqual({ '1': { fixed: 'x' }, '2': { fixed: 'y' } });
  });

  const gatedChildWorkflow: WorkflowDefinition = {
    name: 'gated-child',
    title: 'Gated child',
    scope: 'global',
    steps: [
      { kind: 'agent', id: 'draft', agent: 'scout', input: ['inputs.prompt'], output: 'draft' },
      { kind: 'gate', gate: 'approve', id: 'approve', show: ['draft'], editable: false },
      { kind: 'agent', id: 'polish', agent: 'fixer', input: ['draft'], output: 'polish' },
    ],
  };

  const gatedParentWorkflow: WorkflowDefinition = {
    name: 'parent',
    title: 'Parent',
    scope: 'global',
    steps: [
      { kind: 'workflow', id: 'review', workflow: 'gated-child' },
      { kind: 'agent', id: 'wrap', agent: 'style', input: ['review'], output: 'result' },
    ],
  };

  it("a sub-workflow's gate pauses the parent and a resolution forwards into it", async () => {
    const engine = new ScriptedEngine([
      [done({ text: 'v1' })],
      [done({ text: 'v1 polished' })],
      [done({ ok: true })],
    ]);
    const { deps, events } = makeDeps(engine);
    const run = new WorkflowRun(gatedParentWorkflow, context, {
      ...deps,
      resolveWorkflow: (name) => (name === 'gated-child' ? gatedChildWorkflow : undefined),
    });
    await run.start();
    expect(run.currentStatus).toBe('waiting-gate');
    expect(run.waitingStep()).toEqual({ kind: 'gate', stepId: 'review/approve' });
    const opened = events.find((event) => event.type === 'gate-opened');
    expect(opened).toMatchObject({ stepId: 'review/approve' });

    await run.resolveGate('review/approve', true);
    expect(run.currentStatus).toBe('completed');
    // the child hands back EVERYTHING it produced, keyed by step
    expect(run.collectedOutputs()['review']).toEqual({
      draft: { text: 'v1' },
      approve: { approved: true, note: '', rejections: 0 }, // the gate writes its outcome like any step
      polish: { text: 'v1 polished' },
    });
    expect(engine.specs[2]?.userMessage).toContain('polished');
  });

  it('a rejected sub-workflow gate loops inside the child, not the parent', async () => {
    const engine = new ScriptedEngine([
      [done({ text: 'v1' })],
      [done({ text: 'v2' })],
      [done({ text: 'v2 polished' })],
      [done({ ok: true })],
    ]);
    const { deps, events } = makeDeps(engine);
    const run = new WorkflowRun(gatedParentWorkflow, context, {
      ...deps,
      resolveWorkflow: (name) => (name === 'gated-child' ? gatedChildWorkflow : undefined),
    });
    await run.start();
    await run.resolveGate('review/approve', false, 'tighter please');
    expect(run.currentStatus).toBe('waiting-gate'); // child redid draft, gate re-opened
    expect(run.waitingStep()).toEqual({ kind: 'gate', stepId: 'review/approve' });
    const loops = events.filter((event) => event.type === 'loop-back');
    expect(loops).toHaveLength(1);
    expect(loops[0]).toMatchObject({ fromStepId: 'review/approve', toStepId: 'review/draft' });
    await run.resolveGate('review/approve', true);
    expect(run.currentStatus).toBe('completed');
  });

  it('a crash while a sub-workflow gate is open resumes back to that exact gate', async () => {
    const priorEvents: RunEvent[] = [
      { type: 'run-started', workflowName: 'parent' },
      { type: 'step-started', stepId: 'review', stepKind: 'workflow', attempt: 1 },
      { type: 'step-started', stepId: 'review/draft', stepKind: 'agent', attempt: 1 },
      { type: 'step-completed', stepId: 'review/draft', report: { text: 'v1' } },
      { type: 'gate-opened', stepId: 'review/approve', show: ['draft'] },
      { type: 'run-interrupted', reason: 'crash' },
      { type: 'run-resumed' },
    ];
    const engine = new ScriptedEngine([[done({ text: 'v1 polished' })], [done({ ok: true })]]);
    const { deps } = makeDeps(engine);
    const run = WorkflowRun.resume(
      gatedParentWorkflow,
      context,
      {
        ...deps,
        resolveWorkflow: (name) => (name === 'gated-child' ? gatedChildWorkflow : undefined),
      },
      priorEvents,
    );
    expect(run.currentStatus).toBe('waiting-gate');
    expect(run.waitingStep()).toEqual({ kind: 'gate', stepId: 'review/approve' });
    await run.resolveGate('review/approve', true);
    expect(run.currentStatus).toBe('completed');
    expect(engine.specs).toHaveLength(2); // polish + wrap - draft was NOT re-run
    expect(run.collectedOutputs()['review']).toEqual({
      draft: { text: 'v1' },
      approve: { approved: true, note: '', rejections: 0 }, // the gate writes its outcome like any step
      polish: { text: 'v1 polished' },
    });
  });

  it('on_fail: continue keeps the survivors and marks the failed branch', async () => {
    const workflow: WorkflowDefinition = {
      name: 'tolerant',
      title: 'Tolerant',
      scope: 'global',
      steps: [
        {
          kind: 'parallel',
          id: 'checks',
          onFail: 'continue',
          children: [
            [{ kind: 'agent', id: 'good', agent: 'bugs', input: ['inputs.prompt'] }],
            [{ kind: 'agent', id: 'broken', agent: 'no-such-agent', input: ['inputs.prompt'] }],
          ],
        },
        { kind: 'agent', id: 'wrap', agent: 'style', input: ['checks'], output: 'result' },
      ],
    };
    const engine = new ScriptedEngine([[done({ found: 2 })], [done({ ok: true })]]);
    const { deps } = makeDeps(engine);
    const run = new WorkflowRun(workflow, context, deps);
    await run.start();
    expect(run.currentStatus).toBe('completed');
    expect(run.collectedOutputs()['checks']).toEqual({
      good: { found: 2 },
      broken: { failed: true },
    });
  });

  it('on_fail: ask records partial results and opens a gate at the fork', async () => {
    const workflow: WorkflowDefinition = {
      name: 'asky',
      title: 'Asky',
      scope: 'global',
      steps: [
        {
          kind: 'parallel',
          id: 'checks',
          onFail: 'ask',
          children: [
            [{ kind: 'agent', id: 'good', agent: 'bugs', input: ['inputs.prompt'] }],
            [{ kind: 'agent', id: 'broken', agent: 'no-such-agent', input: ['inputs.prompt'] }],
          ],
        },
        { kind: 'agent', id: 'wrap', agent: 'style', input: ['checks'], output: 'result' },
      ],
    };
    const engine = new ScriptedEngine([[done({ found: 2 })], [done({ ok: true })]]);
    const { deps } = makeDeps(engine);
    const run = new WorkflowRun(workflow, context, deps);
    await run.start();
    expect(run.currentStatus).toBe('waiting-gate');
    expect(run.waitingStep()).toEqual({ kind: 'gate', stepId: 'checks' });
    await run.resolveGate('checks', true);
    expect(run.currentStatus).toBe('completed');
    expect(run.collectedOutputs()['checks']).toMatchObject({ broken: { failed: true } });
  });

  it('a fork where every branch fails still fails the run under on_fail: continue', async () => {
    const workflow: WorkflowDefinition = {
      name: 'doomed',
      title: 'Doomed',
      scope: 'global',
      steps: [
        {
          kind: 'parallel',
          id: 'checks',
          onFail: 'continue',
          children: [
            [{ kind: 'agent', id: 'a', agent: 'nope-1', input: [] }],
            [{ kind: 'agent', id: 'b', agent: 'nope-2', input: [] }],
          ],
        },
      ],
    };
    const engine = new ScriptedEngine([]);
    const { deps, events } = makeDeps(engine);
    const run = new WorkflowRun(workflow, context, deps);
    await run.start();
    expect(run.currentStatus).toBe('failed');
    const failure = events.at(-1);
    expect(failure?.type === 'run-failed' && failure.message).toContain('every branch failed');
  });

  it('a fork branch hitting a usage limit interrupts the whole run, even under on_fail: continue', async () => {
    const workflow: WorkflowDefinition = {
      name: 'tolerant-quota',
      title: 'Tolerant quota',
      scope: 'global',
      steps: [
        {
          kind: 'parallel',
          id: 'checks',
          onFail: 'continue',
          children: [
            [{ kind: 'agent', id: 'good', agent: 'bugs', input: ['inputs.prompt'] }],
            [{ kind: 'agent', id: 'broken', agent: 'style', input: ['inputs.prompt'] }],
          ],
        },
        { kind: 'agent', id: 'wrap', agent: 'fixer', input: ['checks'], output: 'result' },
      ],
    };
    const engine = new ScriptedEngine([
      [done({ found: 2 })],
      [
        {
          type: 'error',
          message: 'Claude AI usage limit reached|9999999999',
          isQuotaError: true,
          retryAt: '2286-11-20T17:46:39.000Z',
        },
      ],
    ]);
    const { deps, events } = makeDeps(engine);
    const run = new WorkflowRun(workflow, context, deps);
    await run.start();

    expect(run.currentStatus).toBe('cancelled');
    // No retry for the quota branch: exactly one session per child, never two.
    expect(engine.sessions).toHaveLength(2);
    const interrupted = events.find((event) => event.type === 'run-interrupted');
    expect(interrupted).toMatchObject({
      type: 'run-interrupted',
      cause: 'quota',
      reason: 'Claude AI usage limit reached|9999999999',
      retryAt: '2286-11-20T17:46:39.000Z',
    });
    expect(events.some((event) => event.type === 'run-failed')).toBe(false);
    // The 'wrap' step never runs - the run stopped at the fork.
    expect(events.some((event) => event.type === 'step-started' && event.stepId === 'wrap')).toBe(
      false,
    );
  });

  it('conditions can branch on run state - gate rejections', async () => {
    const workflow: WorkflowDefinition = {
      name: 'runstate',
      title: 'Run state',
      scope: 'global',
      steps: [
        { kind: 'agent', id: 'fix', agent: 'fixer', input: ['inputs.prompt'], output: 'fix' },
        { kind: 'gate', gate: 'approve', id: 'approve', show: ['fix'], editable: false },
        {
          kind: 'condition',
          id: 'check',
          path: 'run.rejections.approve',
          compare: { op: 'gte', value: 1 },
          then: { kind: 'goto', stepId: 'extra' },
        },
        { kind: 'agent', id: 'extra', agent: 'style', input: ['fix'], output: 'extra' },
      ],
    };
    const engine = new ScriptedEngine([
      [done({ text: 'v1' })],
      [done({ text: 'v2' })],
      [done({ checked: true })],
    ]);
    const { deps, events } = makeDeps(engine);
    const run = new WorkflowRun(workflow, context, deps);
    await run.start();
    await run.resolveGate('approve', false, 'redo'); // loops back to fix
    await run.resolveGate('approve', true);
    expect(run.currentStatus).toBe('completed');
    const branch = events.find((event) => event.type === 'condition-evaluated');
    expect(branch).toMatchObject({
      path: 'run.rejections.approve',
      value: 1,
      result: true,
      to: 'extra',
    });
  });

  it('a fork with on_blocking loops back when ANY branch reports blocking', async () => {
    const workflow: WorkflowDefinition = {
      name: 'swarm',
      title: 'Swarm',
      scope: 'global',
      steps: [
        {
          kind: 'agent',
          id: 'implement',
          agent: 'fixer',
          input: ['inputs.prompt'],
          output: 'impl',
        },
        {
          kind: 'parallel',
          id: 'reviews',
          onBlocking: { gotoStepId: 'implement', maxLoops: 2, then: 'gate' },
          children: [
            [{ kind: 'agent', id: 'bugs', agent: 'bugs', input: ['inputs.prompt'] }],
            [{ kind: 'agent', id: 'style', agent: 'style', input: ['inputs.prompt'] }],
          ],
        },
      ],
    };
    const engine = new ScriptedEngine([
      [done({ files: 1 })], // implement pass 1
      [done({ blocking: true, list: ['x'] })], // bugs pass 1 - blocking
      [done({ blocking: false })], // style pass 1
      [done({ files: 2 })], // implement pass 2 (with feedback)
      [done({ blocking: false })], // bugs pass 2
      [done({ blocking: false })], // style pass 2
    ]);
    const { deps, events } = makeDeps(engine);
    const run = new WorkflowRun(workflow, context, deps);
    await run.start();
    expect(run.currentStatus).toBe('completed');
    expect(engine.specs).toHaveLength(6); // BOTH branches re-ran on the second pass
    const loop = events.find((event) => event.type === 'loop-back');
    expect(loop).toMatchObject({
      fromStepId: 'reviews',
      toStepId: 'implement',
      reason: 'blocking-review',
    });
    // the second implement received the blocking branch as feedback
    expect(engine.specs[3]?.userMessage).toContain('blocking');
    expect(run.collectedOutputs()['reviews']).toEqual({
      bugs: { blocking: false },
      style: { blocking: false },
    });
  });

  it('a while loop re-runs a for_each instead of skipping remembered items', async () => {
    const workflow: WorkflowDefinition = {
      name: 'fixloop',
      title: 'Fix loop',
      scope: 'global',
      steps: [
        { kind: 'agent', id: 'review', agent: 'scout', input: ['inputs.prompt'], output: 'review' },
        {
          kind: 'foreach',
          id: 'fix-all',
          path: 'review.findings',
          itemName: 'finding',
          maxItems: 10,
          template: { kind: 'agent', id: 'item', agent: 'fixer', input: ['finding'] },
        },
        {
          kind: 'while',
          id: 'again',
          path: 'review.blocking',
          compare: { op: 'equals', value: true },
          gotoStepId: 'review',
          maxLoops: 3,
        },
      ],
    };
    const engine = new ScriptedEngine([
      [done({ blocking: true, findings: ['a'] })], // review pass 1
      [done({ fixed: 'a' })], // fixer pass 1
      [done({ blocking: false, findings: ['b'] })], // review pass 2
      [done({ fixed: 'b' })], // fixer pass 2 - re-ran!
    ]);
    const { deps } = makeDeps(engine);
    const run = new WorkflowRun(workflow, context, deps);
    await run.start();
    expect(run.currentStatus).toBe('completed');
    expect(engine.specs).toHaveLength(4);
    expect(run.collectedOutputs()['fix-all']).toEqual({ '1': { fixed: 'b' } });
    // the while jump handed the target WHY it looped, like on_blocking does
    expect(engine.specs[2]?.userMessage).toContain('Looping back (1/3)');
  });

  it('an agent can ask the user mid-run and continue the SAME session with the answer', async () => {
    const workflow: WorkflowDefinition = {
      name: 'asky',
      title: 'Asky',
      scope: 'global',
      steps: [
        { kind: 'agent', id: 'plan', agent: 'scout', input: ['inputs.prompt'], output: 'plan' },
      ],
    };
    const engine = new ScriptedEngine([
      [done({ ask_user: 'OAuth or API keys for the integration?' }), done({ plan: 'oauth' })],
    ]);
    const { deps, events } = makeDeps(engine);
    const run = new WorkflowRun(workflow, context, deps);
    const finished = run.start();

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(run.currentStatus).toBe('waiting-gate');
    const opened = events.find((event) => event.type === 'gate-opened');
    expect(opened).toMatchObject({
      stepId: 'plan',
      question: 'OAuth or API keys for the integration?',
      promptKind: 'question',
    });

    await run.resolveGate('plan', true, 'OAuth with PKCE');
    await finished;
    expect(run.currentStatus).toBe('completed');
    // the answer went into the SAME session, not a new one
    expect(engine.sessions).toHaveLength(1);
    expect(engine.sessions[0]?.sent).toContain('OAuth with PKCE');
    expect(run.collectedOutputs()['plan']).toEqual({ plan: 'oauth' });
  });

  it('a resumed parallel step re-runs only the children without outputs', async () => {
    const workflow: WorkflowDefinition = {
      name: 'fanout',
      title: 'Fanout',
      scope: 'global',
      steps: [
        {
          kind: 'parallel',
          id: 'reviews',
          children: [
            [{ kind: 'agent', id: 'bugs', agent: 'bugs', input: [], output: 'bugs' }],
            [{ kind: 'agent', id: 'style', agent: 'style', input: [], output: 'style' }],
          ],
        },
      ],
    };
    const priorEvents: RunEvent[] = [
      { type: 'run-started', workflowName: 'fanout' },
      { type: 'step-started', stepId: 'reviews', stepKind: 'parallel', attempt: 1 },
      { type: 'step-started', stepId: 'reviews/bugs', stepKind: 'agent', attempt: 1 },
      { type: 'step-completed', stepId: 'reviews/bugs', report: { list: ['found'] } },
      { type: 'run-interrupted', reason: 'crash' },
      { type: 'run-resumed' },
    ];
    const engine = new ScriptedEngine([[done({ notes: ['s1'] })]]); // ONLY style runs
    const { deps } = makeDeps(engine);
    const run = WorkflowRun.resume(workflow, context, deps, priorEvents);
    await run.continueRun();
    expect(run.currentStatus).toBe('completed');
    expect(engine.specs).toHaveLength(1);
    expect(run.collectedOutputs()['bugs']).toEqual({ list: ['found'] });
  });
});
