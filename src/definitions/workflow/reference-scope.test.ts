import { describe, expect, it } from 'vitest';
import {
  backwardJumps,
  checkReference,
  pipelineJumps,
  reachableLaterSteps,
  referenceScope,
} from './reference-scope';
import type { AgentStep, WorkflowStep } from './workflow-step';

const agent = (id: string, agentName: string, extra: Partial<AgentStep> = {}): AgentStep => ({
  kind: 'agent',
  id,
  agent: agentName,
  input: [],
  ...extra,
});

const REPORTS = {
  planner: JSON.stringify({ summary: 'x', steps: ['a'], risky: false, confidence: 0.9 }),
  reviewer: JSON.stringify({ blocking: false, findings: [] }),
};

describe('referenceScope', () => {
  it('registers an agent under its id and its alias, expanded through its report skeleton, lists gaining .length', () => {
    const steps: WorkflowStep[] = [
      agent('plan', 'planner', { output: 'the-plan' }),
      agent('implement', 'engineer'),
    ];
    const hints = referenceScope(steps, { index: 1 }, { agentReports: REPORTS });
    const paths = hints.map((hint) => hint.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        'plan',
        'plan.summary',
        'plan.steps',
        'plan.steps.length',
        'plan.risky',
        'the-plan',
        'the-plan.confidence',
      ]),
    );
    expect(hints.find((hint) => hint.path === 'plan.confidence')).toMatchObject({
      type: 'number',
      example: '0.9',
    });
    expect(hints.find((hint) => hint.path === 'plan.steps.length')).toMatchObject({
      type: 'number',
    });
    expect(hints.find((hint) => hint.path === 'the-plan')?.source).toBe('alias of plan');
    // the step being edited never sees itself
    expect(paths).not.toContain('implement');
  });

  it('hints every control step’s own output, and a condition’s .output typed from the ran side’s last agent', () => {
    const steps: WorkflowStep[] = [
      agent('scout', 'reviewer'),
      {
        kind: 'condition',
        id: 'risky',
        path: 'scout.blocking',
        compare: { op: 'equals', value: true },
        then: { kind: 'steps', steps: [agent('deep', 'planner')] },
        else: {
          kind: 'steps',
          steps: [{ kind: 'gate', gate: 'approve', id: 'ok', show: [], editable: false }],
        },
      },
      {
        kind: 'while',
        id: 'again',
        path: 'scout.blocking',
        compare: { op: 'truthy' },
        gotoStepId: 'scout',
        maxLoops: 2,
      },
      { kind: 'goto', id: 'retry', targetStepId: 'scout', maxLoops: 1 },
      { kind: 'script', id: 'ship', command: 'github-create-pr' },
      agent('wrap', 'planner'),
    ];
    const hints = referenceScope(steps, { index: 5 }, { agentReports: REPORTS });
    const byPath = new Map(hints.map((hint) => [hint.path, hint]));
    expect(byPath.get('risky.result')?.type).toBe('boolean');
    expect(byPath.get('risky.branch')?.type).toBe('string');
    expect(byPath.get('risky.output')?.type).toBe('object'); // the then side ends in a planner → its skeleton
    expect(byPath.get('risky.output.summary')?.type).toBe('string');
    expect(byPath.get('risky.output')?.conditional).toBeUndefined(); // available whichever side ran
    expect(byPath.get('deep')?.conditional).toBe('only when risky takes ✓ then');
    expect(byPath.get('ok.approved')?.conditional).toBe('only when risky takes ✗ else');
    expect(byPath.get('again.looped')?.type).toBe('boolean');
    expect(byPath.get('retry.jumped')?.type).toBe('boolean');
    expect(byPath.get('ship')?.type).toBe('unknown'); // a script's report - last JSON line
    expect(byPath.get('run.loops.again')?.type).toBe('number');
    expect(byPath.get('run.loops.retry')?.type).toBe('number');
  });

  it('flags later steps as later when a loop brings them back, unreachable when nothing does', () => {
    const steps: WorkflowStep[] = [
      agent('implement', 'engineer'),
      agent('check', 'reviewer'),
      {
        kind: 'condition',
        id: 'still-blocking',
        path: 'check.blocking',
        compare: { op: 'truthy' },
        then: {
          kind: 'steps',
          steps: [{ kind: 'goto', id: 'retry', targetStepId: 'implement', maxLoops: 2 }],
        },
      },
      agent('summarize', 'planner'),
    ];
    // from implement: the lane's goto (fires at index 2) lands on implement (0) → check and still-blocking come back
    const fromImplement = referenceScope(steps, { index: 0 });
    expect(fromImplement.find((hint) => hint.path === 'check')).toMatchObject({ later: true });
    expect(fromImplement.find((hint) => hint.path === 'still-blocking.result')).toMatchObject({
      later: true,
    });
    expect(fromImplement.find((hint) => hint.path === 'summarize')).toMatchObject({
      later: true,
      unreachable: true,
    });
    // from check: the goto fires at index 2, not at or after 3, so summarize can never have run before check
    const fromCheck = referenceScope(steps, { index: 1 });
    expect(fromCheck.find((hint) => hint.path === 'summarize')).toMatchObject({
      unreachable: true,
    });
    expect(fromCheck.find((hint) => hint.path === 'still-blocking.result')).toMatchObject({
      later: true,
    });
    expect(
      fromCheck.find((hint) => hint.path === 'still-blocking.result')?.unreachable,
    ).toBeUndefined();
  });

  it('scopes a lane step to the pipeline before its host, the earlier steps of its own lane, and its host’s decision - never a sibling lane', () => {
    const steps: WorkflowStep[] = [
      agent('scout', 'reviewer'),
      {
        kind: 'condition',
        id: 'risky',
        path: 'scout.blocking',
        compare: { op: 'truthy' },
        then: {
          kind: 'steps',
          steps: [agent('first', 'planner'), agent('second', 'planner'), agent('third', 'planner')],
        },
        else: { kind: 'steps', steps: [agent('other', 'planner')] },
      },
      agent('after', 'planner'),
    ];
    const hints = referenceScope(steps, { index: 1, path: [{ lane: 'then', at: 1 }] });
    const paths = hints.filter((hint) => !hint.unreachable).map((hint) => hint.path);
    expect(paths).toContain('scout');
    expect(paths).toContain('first');
    expect(paths).toContain('risky.result'); // the host's own decision is readable inside its lanes
    expect(paths).not.toContain('second'); // itself
    expect(paths).not.toContain('third'); // later in the same lane
    expect(paths).not.toContain('other'); // the sibling lane never ran
    expect(hints.find((hint) => hint.path === 'first')?.conditional).toBeUndefined(); // inside the lane it always ran
    expect(hints.find((hint) => hint.path === 'after')).toMatchObject({ unreachable: true });
  });

  it('names a fork’s branches: a one-step branch is its report, a chain is its steps’ outputs by name', () => {
    const steps: WorkflowStep[] = [
      {
        kind: 'parallel',
        id: 'fan',
        children: [
          [agent('a', 'planner')],
          [agent('b1', 'reviewer'), agent('b2', 'planner', { output: 'polished' })],
        ],
      },
      agent('after', 'planner'),
    ];
    const hints = referenceScope(steps, { index: 1 }, { agentReports: REPORTS });
    const paths = hints.map((hint) => hint.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        'fan',
        'fan.a',
        'fan.a.summary',
        'fan.b1',
        'fan.b1.b1',
        'fan.b1.polished',
        'fan.b1.polished.summary',
      ]),
    );
    // and every inner step by its own name, since a fork's outputs flat-merge
    expect(paths).toEqual(expect.arrayContaining(['a', 'b1', 'b2', 'polished']));
  });
});

describe('pipeline jumps', () => {
  const steps: WorkflowStep[] = [
    agent('a', 'x'),
    agent('b', 'x', { onBlocking: { gotoStepId: 'a', maxLoops: 2, then: 'gate' } }),
    {
      kind: 'condition',
      id: 'c',
      path: 'b.blocking',
      compare: { op: 'truthy' },
      then: { kind: 'goto', stepId: 'e' }, // forward skip - not a loop
      else: {
        kind: 'steps',
        steps: [{ kind: 'goto', id: 'back', targetStepId: 'a', maxLoops: 1 }],
      },
    },
    {
      kind: 'while',
      id: 'd',
      path: 'b.blocking',
      compare: { op: 'truthy' },
      gotoStepId: 'b',
      maxLoops: 3,
    },
    agent('e', 'x'),
  ];

  it('lists every pipeline jump with the top-level index it fires at, backward ones separately', () => {
    expect(pipelineJumps(steps)).toEqual([
      { from: 1, to: 0, stepId: 'b' },
      { from: 2, to: 4, stepId: 'c' },
      { from: 2, to: 0, stepId: 'back' },
      { from: 3, to: 1, stepId: 'd' },
    ]);
    expect(backwardJumps(steps).map((jump) => jump.stepId)).toEqual(['b', 'back', 'd']);
  });

  it('a later step is reachable from an earlier one when a jump fires at or after it and lands at or before the earlier one', () => {
    // from a: b's on_blocking and the lane's goto land on a → b and c come back; d only loops to b, so d never re-runs a; e has nothing after it
    expect([...reachableLaterSteps(steps, 0).keys()]).toEqual([1, 2]);
    expect(reachableLaterSteps(steps, 0).get(2)?.stepId).toBe('back');
    // from b: d's while (fires at 3) lands on b → c and d come back
    expect([...reachableLaterSteps(steps, 1).keys()]).toEqual([2, 3]);
    expect(reachableLaterSteps(steps, 1).get(3)?.stepId).toBe('d');
    expect([...reachableLaterSteps(steps, 3).keys()]).toEqual([]);
  });
});

describe('checkReference', () => {
  const steps: WorkflowStep[] = [
    agent('plan', 'planner'),
    agent('check', 'reviewer'),
    {
      kind: 'condition',
      id: 'risky',
      path: 'check.blocking',
      compare: { op: 'truthy' },
      then: { kind: 'steps', steps: [agent('deep', 'planner')] },
    },
    agent('wrap', 'planner'),
    {
      kind: 'while',
      id: 'again',
      path: 'check.blocking',
      compare: { op: 'truthy' },
      gotoStepId: 'wrap',
      maxLoops: 1,
    },
    agent('never', 'planner'),
  ];
  const hints = referenceScope(steps, { index: 3 }, { agentReports: REPORTS });

  it('accepts extras, exact paths, .length on lists and strings, and untyped producers', () => {
    expect(checkReference('task', hints, ['task', 'all'])).toEqual({ level: 'ok' });
    expect(checkReference('plan.summary', hints)).toEqual({ level: 'ok' });
    expect(checkReference('plan.steps.length', hints)).toEqual({ level: 'ok' });
    expect(checkReference('plan.summary.length', hints)).toEqual({ level: 'ok' });
    expect(checkReference('risky.output', hints)).toEqual({ level: 'ok' });
  });

  it('grades a lane output as info, a looped-back later step as warning, an unreachable later step as error', () => {
    expect(checkReference('deep', hints)).toMatchObject({ level: 'info', code: 'ref/conditional' });
    expect(checkReference('again.looped', hints)).toMatchObject({
      level: 'warning',
      code: 'ref/later-pass',
    });
    expect(checkReference('never', hints)).toMatchObject({
      level: 'error',
      code: 'ref/unreachable-later',
    });
    expect(checkReference('never.summary', hints)).toMatchObject({
      level: 'error',
      code: 'ref/unreachable-later',
    });
  });

  it('warns on a field the skeleton lacks and on unknown run state; errors with a guess on an unknown root', () => {
    expect(checkReference('plan.nope', hints)).toMatchObject({
      level: 'warning',
      code: 'ref/not-in-skeleton',
    });
    expect(checkReference('run.whatever', hints)).toMatchObject({
      level: 'warning',
      code: 'ref/unknown-run-field',
    });
    expect(checkReference('plann', hints)).toMatchObject({
      level: 'error',
      code: 'ref/unknown-producer',
      hint: 'did you mean plan?',
    });
  });
});
