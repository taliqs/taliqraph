import { describe, expect, it } from 'vitest';
import { lintWorkflow } from './lint-workflow';
import type { WorkflowDefinition } from './workflow-definition';
import type { AgentStep, WorkflowStep } from './workflow-step';

const KNOWN = {
  agentNames: ['planner', 'engineer', 'reviewer'],
  workflowNames: ['review-loop', 'main'],
};

function workflow(steps: WorkflowStep[]): WorkflowDefinition {
  return {
    name: 'main',
    title: 'Main',
    scope: 'global',
    steps,
  };
}

const agent = (id: string, agentName: string, extra: Partial<AgentStep> = {}): AgentStep => ({
  kind: 'agent',
  id,
  agent: agentName,
  input: [],
  ...extra,
});

describe('lintWorkflow', () => {
  it('checks a gate: the ticked list must resolve, choice ids are unique, conditions compare real choices', () => {
    const gate: WorkflowStep = {
      kind: 'gate',
      gate: 'select',
      id: 'triage',
      show: ['plan'],
      editable: false,
      list: 'nowhere.findings',
      choices: [
        { id: 'post', label: 'Post', needs: 'selection' },
        { id: 'post', label: 'Again', needs: 'none' },
      ],
    };
    const route: WorkflowStep = {
      kind: 'condition',
      id: 'route',
      path: 'triage.choice',
      compare: { op: 'in', value: ['post', 'nope'] },
      then: { kind: 'steps', steps: [] },
    };
    const result = lintWorkflow(workflow([agent('plan', 'planner'), gate, route]), KNOWN);
    const codes = result.problems.map((problem) => problem.code);
    expect(codes).toContain('ref/unknown-producer');
    expect(codes).toContain('gate/duplicate-choice');
    expect(codes).toContain('gate/unknown-choice');
    expect(
      result.problems.find((problem) => problem.code === 'gate/unknown-choice')?.message,
    ).toContain("'nope'");
  });

  it('accepts a list the shown step produced, and a condition on an offered choice', () => {
    const gate: WorkflowStep = {
      kind: 'gate',
      gate: 'select',
      id: 'triage',
      show: ['plan'],
      editable: false,
      list: 'plan.findings',
      choices: [{ id: 'post', label: 'Post', needs: 'selection' }],
    };
    const route: WorkflowStep = {
      kind: 'condition',
      id: 'route',
      path: 'triage.choice',
      compare: { op: 'equals', value: 'post' },
      then: { kind: 'steps', steps: [] },
    };
    const result = lintWorkflow(workflow([agent('plan', 'planner'), gate, route]), KNOWN);
    expect(result.problems).toEqual([]); // `triage.choice` is a known gate field, not a skeleton miss
  });

  it('passes a well-formed pipeline with an if/else, a loop, a gate and a sub-workflow', () => {
    const result = lintWorkflow(
      workflow([
        agent('plan', 'planner'),
        {
          kind: 'gate',
          gate: 'approve',
          id: 'approve-plan',
          show: ['plan', 'diff'],
          editable: true,
        },
        agent('implement', 'engineer', { input: ['plan'], output: 'implementation' }),
        { kind: 'workflow', id: 'review', workflow: 'review-loop' },
        {
          kind: 'while',
          id: 'fix-loop',
          path: 'review.bug-hunt.blocking',
          compare: { op: 'truthy' },
          gotoStepId: 'implement',
          maxLoops: 2,
        },
        {
          kind: 'condition',
          id: 'still-blocking',
          path: 'review.bug-hunt.blocking',
          compare: { op: 'truthy' },
          then: {
            kind: 'steps',
            steps: [
              { kind: 'gate', gate: 'approve', id: 'escalate', show: ['review'], editable: false },
            ],
          },
        },
        agent('summarize', 'planner', {
          input: ['implementation', 'still-blocking.result', 'still-blocking.output', 'all'],
        }),
        { kind: 'finish', id: 'done' },
      ]),
      KNOWN,
    );
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.counts).toEqual({ error: 0, warning: 0, info: 0 });
  });

  it('reports a reference nothing produces as an error, located to the exact input, with a guess', () => {
    const result = lintWorkflow(
      workflow([agent('plan', 'planner'), agent('implement', 'engineer', { input: ['plann'] })]),
      KNOWN,
    );
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([
      {
        code: 'ref/unknown-producer',
        severity: 'error',
        message: 'input: nothing produces ‘plann’',
        where: {
          stepId: 'implement',
          address: ['steps', 1, 'input', 0],
          field: 'input',
          ref: 'plann',
        },
        hint: 'did you mean plan?',
      },
    ]);
  });

  it('errors on a later step nothing loops back from, warns on one a loop does bring back', () => {
    const result = lintWorkflow(
      workflow([
        agent('implement', 'engineer', { input: ['check'] }), // check comes back via retry → fine, warned
        agent('check', 'reviewer', { input: ['summarize'] }), // summarize can never have run → error
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
      ]),
      KNOWN,
    );
    expect(
      result.problems.map((problem) => [problem.code, problem.severity, problem.where.stepId]),
    ).toEqual([
      ['ref/later-pass', 'warning', 'implement'],
      ['ref/unreachable-later', 'error', 'check'],
    ]);
    expect(result.problems[1]?.message).toBe(
      'input: ‘summarize’ runs after this step and nothing loops back before it - it can never be available here',
    );
  });

  it('marks a reference to one side’s output as info, and a field missing from the skeleton as a warning', () => {
    const result = lintWorkflow(
      workflow([
        agent('scout', 'reviewer'),
        {
          kind: 'condition',
          id: 'risky',
          path: 'scout.blocking',
          compare: { op: 'truthy' },
          then: { kind: 'steps', steps: [agent('deep', 'planner')] },
        },
        agent('wrap', 'planner', { input: ['deep', 'scout.nope'] }),
      ]),
      { ...KNOWN, agentReports: { reviewer: JSON.stringify({ blocking: true, findings: [] }) } },
    );
    expect(result.ok).toBe(true);
    expect(result.problems.map((problem) => problem.code)).toEqual([
      'ref/conditional',
      'ref/not-in-skeleton',
    ]);
    expect(result.counts).toEqual({ error: 0, warning: 1, info: 1 });
  });

  it('checks lane steps against their own scope: earlier lane steps and the host’s decision yes, sibling lanes and later steps no', () => {
    const result = lintWorkflow(
      workflow([
        agent('scout', 'reviewer'),
        {
          kind: 'condition',
          id: 'risky',
          path: 'scout.blocking',
          compare: { op: 'truthy' },
          then: {
            kind: 'steps',
            steps: [
              agent('first', 'planner'),
              agent('second', 'planner', { input: ['first', 'risky.branch', 'other', 'after'] }),
            ],
          },
          else: { kind: 'steps', steps: [agent('other', 'planner')] },
        },
        agent('after', 'planner'),
      ]),
      KNOWN,
    );
    expect(
      result.problems.map((problem) => [
        problem.code,
        problem.where.innerStepId,
        problem.where.ref,
      ]),
    ).toEqual([
      ['ref/unknown-producer', 'second', 'other'],
      ['ref/unreachable-later', 'second', 'after'],
    ]);
    expect(result.problems[0]?.where).toMatchObject({
      stepId: 'risky',
      address: ['steps', 1, 'then', 'steps', 1, 'input', 2],
    });
  });

  it('errors on unknown agents, workflows, self-nesting, jump targets and alias collisions', () => {
    const result = lintWorkflow(
      workflow([
        agent('plan', 'nobody'),
        { kind: 'workflow', id: 'sub', workflow: 'missing' },
        { kind: 'workflow', id: 'self', workflow: 'main' },
        {
          kind: 'while',
          id: 'loop',
          path: 'plan.x',
          compare: { op: 'truthy' },
          gotoStepId: 'ghost',
          maxLoops: 1,
        },
        { kind: 'goto', id: 'jump', targetStepId: 'ghost', maxLoops: 1 },
        agent('twin', 'planner', { output: 'plan' }),
      ]),
      KNOWN,
    );
    expect(result.problems.map((problem) => problem.code)).toEqual([
      'agent/unknown',
      'workflow/unknown',
      'workflow/self-nesting',
      'jump/unknown-target',
      'jump/unknown-target',
      'output/alias-collision',
    ]);
    expect(result.problems.every((problem) => problem.severity === 'error')).toBe(true);
    expect(result.problems.at(-1)).toMatchObject({
      where: { stepId: 'twin', field: 'output' },
      related: [{ stepId: 'plan' }],
    });
  });

  it('warns on loop-backs that point forward or into a run-once step', () => {
    const result = lintWorkflow(
      workflow([
        agent('once', 'planner', { when: { maxRuns: 1 } }),
        agent('review', 'reviewer', {
          onBlocking: { gotoStepId: 'once', maxLoops: 2, then: 'gate' },
        }),
        {
          kind: 'while',
          id: 'forward',
          path: 'review.blocking',
          compare: { op: 'truthy' },
          gotoStepId: 'late',
          maxLoops: 1,
        },
        agent('late', 'planner'),
      ]),
      KNOWN,
    );
    expect(result.ok).toBe(true);
    expect(result.problems.map((problem) => problem.code)).toEqual([
      'jump/into-run-once',
      'jump/not-backwards',
    ]);
  });

  it('flags steps after an unconditional finish that nothing jumps to as dead', () => {
    const result = lintWorkflow(
      workflow([
        agent('plan', 'planner'),
        {
          kind: 'condition',
          id: 'maybe',
          path: 'plan.risky',
          compare: { op: 'truthy' },
          then: { kind: 'goto', stepId: 'cleanup' },
        },
        { kind: 'finish', id: 'done' },
        agent('cleanup', 'planner'), // reachable through the condition's jump
        agent('orphan', 'planner'), // never
      ]),
      KNOWN,
    );
    expect(result.problems).toEqual([
      {
        code: 'flow/dead-steps',
        severity: 'error',
        message: "never runs - the pipeline ends at 'done' before it and nothing jumps to it",
        where: { stepId: 'orphan', address: ['steps', 4] },
        related: [{ stepId: 'done', note: 'finishes the run' }],
      },
    ]);
  });

  it('checks script steps against their definitions: positional input counts, name-like commands with no definition, bound references', () => {
    const scripts = [
      {
        name: 'run-tests',
        inputs: [
          { name: 'implementation', required: true },
          { name: 'plan', required: false },
        ],
      },
      { name: 'anything', inputs: [] }, // declares no parameters - takes whatever it is given, as args
    ];
    const result = lintWorkflow(
      workflow([
        agent('implement', 'engineer', { output: 'implementation' }),
        { kind: 'script', id: 'test', command: 'run-tests', input: [] }, // the required first slot is empty
        {
          kind: 'script',
          id: 'again',
          command: 'run-tests',
          input: ['plann', 'implementation'],
        }, // one too many, and a typo
        { kind: 'script', id: 'fine', command: 'run-tests', input: ['implementation'] }, // the optional slot may stay empty
        { kind: 'script', id: 'loose', command: 'anything', input: ['implementation'] }, // no declared parameters - fine
        { kind: 'script', id: 'lint', command: 'run-lint' }, // looks like a name, isn't one
        { kind: 'script', id: 'raw', command: 'pnpm lint --fix', input: ['implementation'] }, // a shell command - fine
      ]),
      { ...KNOWN, scripts },
    );
    expect(
      result.problems.map((problem) => [problem.code, problem.severity, problem.where.stepId]),
    ).toEqual([
      ['script/missing-input', 'error', 'test'],
      ['ref/unknown-producer', 'error', 'again'],
      ['script/unknown', 'warning', 'lint'],
    ]);
    expect(result.problems[0]?.message).toBe(
      "script 'run-tests' takes 2 inputs (implementation, plan?) - 0 given",
    );
    expect(result.problems[0]?.hint).toBe(
      'input: lists them in that order, e.g. [<implementation>, <plan>]',
    );
    // without definitions in context, script names are not judged at all
    expect(
      lintWorkflow(workflow([{ kind: 'script', id: 'lint', command: 'run-lint' }]), KNOWN).problems,
    ).toEqual([]);
  });

  it('checks a for-each’s list, its template agent and its per-item inputs', () => {
    const result = lintWorkflow(
      workflow([
        agent('plan', 'planner'),
        {
          kind: 'foreach',
          id: 'each',
          path: 'plan.items',
          itemName: 'item',
          maxItems: 5,
          template: {
            kind: 'agent',
            id: 'worker',
            agent: 'ghost',
            input: ['item', 'nope'],
          },
        },
      ]),
      KNOWN,
    );
    expect(result.problems.map((problem) => [problem.code, problem.where.field])).toEqual([
      ['agent/unknown', 'agent'],
      ['ref/unknown-producer', 'input'],
    ]);
    expect(result.problems[1]?.where.address).toEqual(['steps', 1, 'template', 'input', 1]);
  });
});

describe('secrets', () => {
  it('errors on a step secret the workflow does not declare, warns on a declared one nobody lists - lanes included', () => {
    const result = lintWorkflow(
      {
        ...workflow([
          agent('plan', 'planner', { secrets: ['GH_TOKEN'] }),
          {
            kind: 'parallel',
            id: 'fork',
            children: [
              [{ kind: 'script', id: 'post', command: 'github-post-review', secrets: ['NOPE'] }],
              [agent('review', 'reviewer')],
            ],
          },
        ]),
        secrets: [
          { name: 'GH_TOKEN', required: true },
          { name: 'JIRA_API_TOKEN', required: false },
        ],
      },
      KNOWN,
    );
    const undeclared = result.problems.find((problem) => problem.code === 'secret/undeclared');
    expect(undeclared).toMatchObject({
      severity: 'error',
      where: { stepId: 'fork', innerStepId: 'post', field: 'secrets', ref: 'NOPE' },
    });
    expect(undeclared?.hint).toContain('GH_TOKEN, JIRA_API_TOKEN, NOPE');
    const unused = result.problems.find((problem) => problem.code === 'secret/unused');
    expect(unused).toMatchObject({ severity: 'warning', where: { ref: 'JIRA_API_TOKEN' } });
    expect(result.ok).toBe(false);
  });

  it('is silent when every listed secret is declared and every declared one is used', () => {
    const result = lintWorkflow(
      {
        ...workflow([agent('plan', 'planner', { secrets: ['GH_TOKEN'] })]),
        secrets: [{ name: 'GH_TOKEN', required: true }],
      },
      KNOWN,
    );
    expect(result.problems.filter((problem) => problem.code.startsWith('secret/'))).toEqual([]);
  });
});

describe('declared inputs', () => {
  it('knows inputs.<name>, errors on unknown inputs and the retired task, warns on unread inputs', () => {
    const result = lintWorkflow(
      {
        ...workflow([
          agent('plan', 'planner', {
            input: ['inputs.prompt', 'inputs.pr', 'inputs.nope', 'task'],
          }),
          { kind: 'finish', id: 'done', input: ['plan'], params: { _summary: 'ok' } },
        ]),
        inputs: [
          { name: 'prompt', type: 'prompt', required: true },
          { name: 'pr', type: 'text', required: true },
          { name: 'unread', type: 'text', required: false },
        ],
      },
      KNOWN,
    );
    const codes = result.problems.map((problem) => `${problem.code}:${problem.where.ref ?? ''}`);
    expect(codes).toContain('ref/unknown-input:inputs.nope');
    expect(codes).toContain('ref/retired-task:task');
    expect(codes).toContain('input/unused:unread');
    expect(
      codes.filter((code) => code.startsWith('ref/') && code.includes('inputs.prompt')),
    ).toEqual([]);
    expect(codes.filter((code) => code.includes('inputs.pr'))).toEqual([]);
    const retired = result.problems.find((problem) => problem.code === 'ref/retired-task');
    expect(retired?.message).toContain('declare what this workflow takes under inputs:');
  });
});
