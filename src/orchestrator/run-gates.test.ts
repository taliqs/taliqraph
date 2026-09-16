import type { WorkflowDefinition } from '../definitions/workflow/workflow-definition';
import { describe, expect, it } from 'vitest';
import { ScriptedEngine, context, done, eventTypes, featureDev, makeDeps } from './test-harness';
import { WorkflowRun } from './workflow-run';

const triageFlow: WorkflowDefinition = {
  name: 'triage-flow',
  title: 'Triage',
  scope: 'global',
  steps: [
    { kind: 'agent', id: 'review', agent: 'reviewer', input: ['inputs.prompt'], output: 'review' },
    {
      kind: 'gate',
      gate: 'select',
      id: 'triage',
      show: ['review'],
      editable: false,
      list: 'review.findings',
      choices: [
        { id: 'post', label: 'Post', needs: 'selection' },
        { id: 'none', label: 'Nothing', needs: 'none' },
      ],
    },
    {
      kind: 'condition',
      id: 'route',
      path: 'triage.choice',
      compare: { op: 'in', value: ['post'] },
      then: {
        kind: 'steps',
        steps: [
          {
            kind: 'script',
            id: 'post',
            command: 'github-post-review',
            // `$ref` params resolve against the outputs and the task's PR when the script runs
            params: {
              pr: '$inputs.pr',
              findings: '$triage.selected',
              mode: '$triage.choice',
              note: 'plain',
              missing: '$nope.x',
            },
          },
        ],
      },
    },
  ],
};
const twoFindings = done({
  findings: [
    { id: 'f1', short: 'null deref' },
    { id: 'f2', short: 'naming', status: 'dismissed', dismissReason: 'withdrawn' },
  ],
});

describe('gates with select and choices', () => {
  it('freezes the items on open, records ticks, and the choice routes the condition and lands in the output', async () => {
    const engine = new ScriptedEngine([[twoFindings]]);
    const { deps, events, scriptRuns } = makeDeps(engine);
    const pr = {
      number: 482,
      url: 'https://github.com/acme/repo/pull/482',
      headRefName: 'fix/timer',
    };
    const run = new WorkflowRun(
      triageFlow,
      { ...context, inputs: { ...context.inputs, pr } },
      deps,
    );
    await run.start();

    const opened = events.find((event) => event.type === 'gate-opened');
    expect(opened?.type === 'gate-opened' && opened.list?.items.map((item) => item.key)).toEqual([
      'f1',
      'f2',
    ]);
    expect(opened?.type === 'gate-opened' && opened.choices?.map((choice) => choice.id)).toEqual([
      'post',
      'none',
    ]);

    // a withdrawn finding starts dismissed; the user dismisses nothing else and posts
    const selection = await run.updateGateSelection('triage', { includeDetails: true });
    expect(selection).toEqual({
      selected: ['f1'],
      dismissed: [{ key: 'f2', reason: 'withdrawn' }],
      includeDetails: true,
    });
    expect(events.some((event) => event.type === 'gate-selection-changed')).toBe(true);

    await run.resolveGate('triage', false, undefined, { choice: 'post' }); // a choice is never a "send back"
    expect(run.currentStatus).toBe('completed');
    expect(run.collectedOutputs()['triage']).toEqual({
      approved: true,
      note: '',
      rejections: 0,
      choice: 'post',
      selected: [{ id: 'f1', short: 'null deref' }],
      dismissed: [
        {
          item: { id: 'f2', short: 'naming', status: 'dismissed', dismissReason: 'withdrawn' },
          reason: 'withdrawn',
        },
      ],
      includeDetails: true,
    });
    expect(scriptRuns.map((entry) => entry.command)).toEqual(['github-post-review']);
    expect(scriptRuns[0]?.inputs).toEqual({
      inputs: { ...context.inputs, pr },
      args: [],
      pr,
      findings: [{ id: 'f1', short: 'null deref' }],
      mode: 'post',
      note: 'plain',
      missing: undefined,
    });
  });

  it('refuses an unknown choice, and a choice that needs a selection when nothing is ticked - the gate stays open', async () => {
    const engine = new ScriptedEngine([[twoFindings]]);
    const { deps } = makeDeps(engine);
    const run = new WorkflowRun(triageFlow, context, deps);
    await run.start();
    await expect(run.resolveGate('triage', true, undefined, { choice: 'nope' })).rejects.toThrow(
      /needs a choice/,
    );
    await run.updateGateSelection('triage', { selected: [] });
    await expect(run.resolveGate('triage', true, undefined, { choice: 'post' })).rejects.toThrow(
      /at least one item/,
    );
    expect(run.currentStatus).toBe('waiting-gate');
    await run.resolveGate('triage', true, undefined, { choice: 'none' });
    expect(run.currentStatus).toBe('completed');
    expect(run.collectedOutputs()['triage']).toMatchObject({ choice: 'none', selected: [] });
  });

  it('a restart keeps the ticks: the gate resumes with the same items and selection', async () => {
    const engine = new ScriptedEngine([[twoFindings]]);
    const { deps, events } = makeDeps(engine);
    const run = new WorkflowRun(triageFlow, context, deps);
    await run.start();
    await run.updateGateSelection('triage', { selected: ['f1'], dismissed: [] }); // f1 ticked, f2 un-dismissed but unticked

    const again = makeDeps(new ScriptedEngine([]));
    const resumed = WorkflowRun.resume(triageFlow, context, again.deps, events);
    expect(resumed.currentStatus).toBe('waiting-gate');
    await resumed.resolveGate('triage', true, undefined, { choice: 'post' });
    expect(resumed.currentStatus).toBe('completed');
    expect(resumed.collectedOutputs()['triage']).toMatchObject({
      choice: 'post',
      selected: [{ id: 'f1', short: 'null deref' }],
      dismissed: [],
    });
  });

  it('a plain gate emits gate-opened and gate-resolved without select, choices or selection', async () => {
    const engine = new ScriptedEngine([[done({ plan: 'v1' })], [done({ files: 1 })]]);
    const { deps, events } = makeDeps(engine);
    const run = new WorkflowRun(featureDev, context, deps);
    await run.start();
    await run.resolveGate('approve-plan', true);
    expect(events.find((event) => event.type === 'gate-opened')).toEqual({
      type: 'gate-opened',
      stepId: 'approve-plan',
      show: ['plan'],
      shown: { plan: { plan: 'v1' } },
      editable: true,
    });
    expect(events.find((event) => event.type === 'gate-resolved')).toEqual({
      type: 'gate-resolved',
      stepId: 'approve-plan',
      approved: true,
    });
  });
});

describe('headless runs', () => {
  it('approves gates with everything ticked and the default choice, answers a question with the fallback - nobody asked', async () => {
    const workflow: WorkflowDefinition = {
      ...featureDev,
      steps: [
        { kind: 'agent', id: 'scan', agent: 'engineer', input: [], output: 'scan' },
        { kind: 'gate', gate: 'approve', id: 'plain', show: ['scan'], editable: false },
        {
          kind: 'gate',
          gate: 'select',
          id: 'triage',
          show: ['scan'],
          editable: false,
          list: 'scan.findings',
          choices: [
            { id: 'skip', label: 'Skip', needs: 'none' },
            { id: 'post', label: 'Post', needs: 'selection', default: true },
          ],
        },
        {
          kind: 'script',
          id: 'post',
          command: 'github-post-review',
          input: ['triage.selected'],
        },
      ],
    };
    const engine = new ScriptedEngine([
      [
        done({ ask_user: 'Which area first?', options: ['auth', 'billing'] }),
        done({
          findings: [
            { id: 'f1', short: 'leak' },
            { id: 'f2', short: 'style', status: 'dismissed' },
          ],
        }),
      ],
    ]);
    const { deps, events, scriptRuns } = makeDeps(engine);
    const run = new WorkflowRun(workflow, context, { ...deps, headless: true });
    await run.start();
    expect(run.currentStatus).toBe('completed');
    // the question got the fallback answer inside the same session
    expect(engine.sessions[0]?.sent.at(-1)).toBe('No answer - proceed with your best judgment.');
    const resolved = events.filter((event) => event.type === 'gate-resolved');
    expect(
      resolved.map(
        (event) => event.type === 'gate-resolved' && [event.stepId, event.by, event.choice],
      ),
    ).toEqual([
      ['scan', 'headless', undefined], // the question
      ['plain', 'headless', undefined],
      ['triage', 'headless', 'post'],
    ]);
    expect(run.collectedOutputs()['triage']).toMatchObject({
      choice: 'post',
      selected: [{ id: 'f1', short: 'leak' }],
      dismissed: [{ item: { id: 'f2', short: 'style', status: 'dismissed' } }],
    });
    expect(scriptRuns.map((entry) => entry.command)).toEqual(['github-post-review']);
    expect(eventTypes(events).at(-1)).toBe('run-completed');
  });

  it('falls back to a choice that needs no ticks when the default needs some and nothing is left', async () => {
    const workflow: WorkflowDefinition = {
      ...featureDev,
      steps: [
        { kind: 'agent', id: 'scan', agent: 'engineer', input: [], output: 'scan' },
        {
          kind: 'gate',
          gate: 'select',
          id: 'triage',
          show: ['scan'],
          editable: false,
          list: 'review.findings',
          choices: [
            { id: 'post', label: 'Post', needs: 'selection', default: true },
            { id: 'none', label: 'Nothing', needs: 'none' },
          ],
        },
      ],
    };
    const engine = new ScriptedEngine([
      [done({ findings: [{ id: 'f1', short: 'x', status: 'dismissed' }] })],
    ]);
    const { deps, events } = makeDeps(engine);
    const run = new WorkflowRun(workflow, context, { ...deps, headless: true });
    await run.start();
    expect(run.currentStatus).toBe('completed');
    expect(
      events.find((event) => event.type === 'gate-resolved' && event.stepId === 'triage'),
    ).toMatchObject({
      choice: 'none',
      by: 'headless',
    });
  });

  it('fails the run with cause budget instead of parking on the budget gate', async () => {
    const engine = new ScriptedEngine([[done({ steps: [] })]]);
    const { deps, events } = makeDeps(engine);
    const run = new WorkflowRun(featureDev, context, {
      ...deps,
      headless: true,
      checkBudget: () => ({ pause: true }),
    });
    await run.start();
    expect(run.currentStatus).toBe('failed');
    const failed = events.find((event) => event.type === 'run-failed');
    expect(failed).toMatchObject({ cause: 'budget' });
    expect(events.some((event) => event.type === 'gate-opened')).toBe(false);
    expect(engine.specs).toHaveLength(0); // nothing was spent
  });
});
