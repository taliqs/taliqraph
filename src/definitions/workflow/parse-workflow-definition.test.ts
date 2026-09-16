import { describe, expect, it } from 'vitest';
import { parseWorkflowDefinition } from './parse-workflow-definition';
import { serializeWorkflowDefinition } from './serialize-workflow-definition';

const featureDev = `
name: feature-dev
title: Feature Dev
extends: global/standard-dev
match: [feature, add, implement, fix]
steps:
  - id: investigate
    agent: investigator
    output: findings
  - id: plan
    agent: planner
    input: [task, findings]
    output: plan
  - id: approve-plan
    gate: approve
    show: plan
    editable: true
  - id: implement
    agent: software-engineer
    model: sonnet-5
    effort: high
  - id: review
    workflow: review-loop
    on_blocking:
      goto: implement
      max_loops: 3
  - id: approve-diff
    gate: approve
    show: [diff, test-results]
  - id: open-pr
    script: github-create-pr
    with:
      target: main
      draft: true
`;

const triage = `
name: pr-review
title: PR Review
steps:
  - id: correctness
    agent: review-correctness
    output: correctness
  - id: triage
    gate: select
    show: [correctness]
    list: correctness.findings
    choices:
      - { id: post, label: Post review }
      - { id: none, label: Done, needs: none }
  - id: route
    if: triage.choice
    in: [post, pending]
    then: post
    else: none
  - id: post
    script: github-post-review
    input: [pr, triage.selected]
    with: { mode: submit }
  - id: none
    finish: run
`;

describe('gate answers', () => {
  it('parses select and choices, defaulting needs to selection, and the in comparator', () => {
    const result = parseWorkflowDefinition(triage, 'global');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.steps[1]).toEqual({
      kind: 'gate',
      gate: 'select',
      id: 'triage',
      show: ['correctness'],
      editable: false,
      list: 'correctness.findings',
      choices: [
        { id: 'post', label: 'Post review', needs: 'selection' },
        { id: 'none', label: 'Done', needs: 'none' },
      ],
    });
    const route = result.value.steps[2];
    expect(route?.kind === 'condition' && route.compare).toEqual({
      op: 'in',
      value: ['post', 'pending'],
    });
  });

  it('round-trips select, choices and in through the serializer', () => {
    const parsed = parseWorkflowDefinition(triage, 'global');
    if (!parsed.ok) throw new Error('parse failed');
    const again = parseWorkflowDefinition(serializeWorkflowDefinition(parsed.value), 'global');
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.value.steps).toEqual(parsed.value.steps);
    expect(serializeWorkflowDefinition(parsed.value)).not.toContain('needs: selection');
  });

  it('rejects a choice id with capitals or spaces', () => {
    const result = parseWorkflowDefinition(
      triage.replace('id: post, label', 'id: Post It, label'),
      'global',
    );
    expect(result.ok).toBe(false);
  });
});

describe('parseWorkflowDefinition', () => {
  it('parses the full feature-dev workflow', () => {
    const result = parseWorkflowDefinition(featureDev, 'project');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const workflow = result.value;
    expect(workflow.name).toBe('feature-dev');
    expect(workflow.extendsName).toBe('global/standard-dev');
    expect(workflow.steps.map((step) => step.kind)).toEqual([
      'agent',
      'agent',
      'gate',
      'agent',
      'workflow',
      'gate',
      'script',
    ]);

    const gate = workflow.steps[2];
    expect(gate).toEqual({
      kind: 'gate',
      gate: 'approve',
      id: 'approve-plan',
      show: ['plan'],
      editable: true,
    });

    const review = workflow.steps[4];
    expect(review).toEqual({
      kind: 'workflow',
      id: 'review',
      workflow: 'review-loop',
      onBlocking: { gotoStepId: 'implement', maxLoops: 3, then: 'gate' },
    });

    const ship = workflow.steps[6];
    expect(ship).toEqual({
      kind: 'script',
      id: 'open-pr',
      command: 'github-create-pr',
      params: { target: 'main', draft: true },
    });
  });

  it('defaults title and isolation', () => {
    const minimal = `
name: quick-fix
steps:
  - id: implement
    agent: software-engineer
  - id: ship
    script: github-create-pr
`;
    const result = parseWorkflowDefinition(minimal, 'global');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.title).toBe('quick-fix');
    expect(result.value.steps[1]?.kind).toBe('script');
  });

  it('rejects duplicate step ids', () => {
    const duplicated = `
name: broken
steps:
  - id: same
    agent: a
  - id: same
    agent: b
`;
    const result = parseWorkflowDefinition(duplicated, 'global');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.issues).toContain("Duplicate step id 'same'");
  });

  it('rejects loop-back targets that do not exist', () => {
    const dangling = `
name: broken
steps:
  - id: review
    workflow: review-loop
    on_blocking:
      goto: implement
`;
    const result = parseWorkflowDefinition(dangling, 'global');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.issues.some((issue) => issue.includes("unknown step 'implement'"))).toBe(
      true,
    );
  });

  it('rejects steps that mix kinds or have none', () => {
    const mixed = `
name: broken
steps:
  - id: confused
    agent: a
    gate: approve
  - id: empty
`;
    const result = parseWorkflowDefinition(mixed, 'global');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.issues.some((issue) => issue.includes('mixes multiple kinds'))).toBe(true);
    expect(result.error.issues.some((issue) => issue.includes('must contain one of'))).toBe(true);
  });
});

describe('graph steps', () => {
  const SOURCE = `
name: graphy
steps:
  - id: investigate
    agent: investigator
    input: [task]
    output: findings
  - id: check
    if: findings.confidence
    gte: 0.8
    then: reviews
    else: investigate
  - id: reviews
    parallel:
      - id: bugs
        agent: reviewer-bugs
        input: [task]
        output: bugs
      - id: style
        agent: review-standards
        input: [task]
        output: style
  - id: keep-going
    while: bugs.blocking
    equals: true
    goto: reviews
    max_loops: 2
`;

  it('parses condition, parallel, and while steps', () => {
    const parsed = parseWorkflowDefinition(SOURCE, 'global');
    if (!parsed.ok) {
      throw new Error(parsed.error.issues.join('; '));
    }
    const [, check, reviews, loop] = parsed.value.steps;
    expect(check).toEqual({
      kind: 'condition',
      id: 'check',
      path: 'findings.confidence',
      compare: { op: 'gte', value: 0.8 },
      then: { kind: 'goto', stepId: 'reviews' },
      else: { kind: 'goto', stepId: 'investigate' },
    });
    expect(reviews?.kind === 'parallel' && reviews.children.map((branch) => branch[0].id)).toEqual([
      'bugs',
      'style',
    ]);
    expect(loop).toMatchObject({
      kind: 'while',
      path: 'bugs.blocking',
      compare: { op: 'equals', value: true },
      gotoStepId: 'reviews',
      maxLoops: 2,
    });
  });

  it('round-trips through the serializer', () => {
    const parsed = parseWorkflowDefinition(SOURCE, 'global');
    if (!parsed.ok) {
      throw new Error('parse failed');
    }
    const reparsed = parseWorkflowDefinition(serializeWorkflowDefinition(parsed.value), 'global');
    if (!reparsed.ok) {
      throw new Error(reparsed.error.issues.join('; '));
    }
    expect(reparsed.value.steps).toEqual(parsed.value.steps);
  });

  it('rejects unknown branch targets, gates/control-flow in a fork, and single-child parallels', () => {
    const bad = parseWorkflowDefinition(
      'name: x\nsteps:\n  - id: c\n    if: a.b\n    then: nowhere\n',
      'global',
    );
    expect(!bad.ok && bad.error.issues.join(' ')).toContain("unknown step 'nowhere'");

    const gateChild = parseWorkflowDefinition(
      'name: x\nsteps:\n  - id: p\n    parallel:\n      - id: g\n        gate: approve\n      - id: a\n        agent: someone\n',
      'global',
    );
    expect(!gateChild.ok && gateChild.error.issues.join(' ')).toContain(
      "a gate can't run inside a branch",
    );

    // a while/condition may nest in a branch, but its jumps are scoped to that branch:
    // 'p' lives in the outer pipeline, not this branch, so it is unknown here
    const whileChild = parseWorkflowDefinition(
      'name: x\nsteps:\n  - id: p\n    parallel:\n      - id: w\n        while: a.b\n        goto: p\n      - id: a\n        agent: someone\n',
      'global',
    );
    expect(!whileChild.ok && whileChild.error.issues.join(' ')).toContain(
      "loops back to unknown step 'p'",
    );

    const single = parseWorkflowDefinition(
      'name: x\nsteps:\n  - id: p\n    parallel:\n      - id: a\n        agent: someone\n',
      'global',
    );
    expect(single.ok).toBe(false);
  });

  it('parses for_each fan-out and round-trips it', () => {
    const source = [
      'name: x',
      'steps:',
      '  - id: review',
      '    agent: reviewer',
      '    output: review',
      '  - id: fix-all',
      '    for_each: review.findings',
      '    as: finding',
      '    max_items: 8',
      '    do:',
      '      agent: fixer',
      '      input: [task, finding]',
      '',
    ].join('\n');
    const parsed = parseWorkflowDefinition(source, 'global');
    if (!parsed.ok) {
      throw new Error(parsed.error.issues.join('; '));
    }
    const fan = parsed.value.steps[1];
    expect(fan).toEqual({
      kind: 'foreach',
      id: 'fix-all',
      path: 'review.findings',
      itemName: 'finding',
      maxItems: 8,
      template: { kind: 'agent', id: 'item', agent: 'fixer', input: ['task', 'finding'] },
    });
    const reparsed = parseWorkflowDefinition(serializeWorkflowDefinition(parsed.value), 'global');
    if (!reparsed.ok) {
      throw new Error(reparsed.error.issues.join('; '));
    }
    expect(reparsed.value.steps).toEqual(parsed.value.steps);

    const badTemplate = parseWorkflowDefinition(
      'name: x\nsteps:\n  - id: f\n    for_each: a.b\n    do:\n      script: echo hi\n',
      'global',
    );
    expect(!badTemplate.ok && badTemplate.error.issues.join(' ')).toContain(
      'runs an agent per item',
    );
  });

  it('accepts any work step as a fork branch - script, sub-workflow, auto script, nested fork', () => {
    const mixed = parseWorkflowDefinition(
      [
        'name: x',
        'steps:',
        '  - id: p',
        '    parallel:',
        '      - id: tests',
        '        script: pnpm test',
        '      - id: review',
        '        workflow: review-loop',
        '      - id: notify',
        '        script: notify-slack',
        '      - id: inner',
        '        parallel:',
        '          - id: a',
        '            agent: one',
        '          - id: b',
        '            agent: two',
        '',
      ].join('\n'),
      'global',
    );
    if (!mixed.ok) {
      throw new Error(mixed.error.issues.join('; '));
    }
    const fork = mixed.value.steps[0];
    expect(fork?.kind === 'parallel' && fork.children.map((branch) => branch[0].kind)).toEqual([
      'script',
      'workflow',
      'script',
      'parallel',
    ]);
    // and it round-trips
    const reparsed = parseWorkflowDefinition(serializeWorkflowDefinition(mixed.value), 'global');
    if (!reparsed.ok) {
      throw new Error(reparsed.error.issues.join('; '));
    }
    expect(reparsed.value.steps).toEqual(mixed.value.steps);
  });
});

describe('multi-step branches', () => {
  it('parses a condition then/else as embedded step lists', () => {
    const source = [
      'name: x',
      'steps:',
      '  - id: c',
      '    if: findings.risky',
      '    then:',
      '      - id: extra-review',
      '        agent: reviewer',
      '      - id: notify',
      '        script: notify-slack',
      '    else:',
      '      - id: quick-note',
      '        agent: scribe',
      '',
    ].join('\n');
    const parsed = parseWorkflowDefinition(source, 'global');
    if (!parsed.ok) {
      throw new Error(parsed.error.issues.join('; '));
    }
    const [check] = parsed.value.steps;
    expect(check).toMatchObject({
      kind: 'condition',
      then: { kind: 'steps', steps: [{ id: 'extra-review' }, { id: 'notify' }] },
      else: { kind: 'steps', steps: [{ id: 'quick-note' }] },
    });
  });

  it('defaults an omitted then/else to an empty steps branch - "just continue"', () => {
    const parsed = parseWorkflowDefinition(
      'name: x\nsteps:\n  - id: c\n    if: a.b\n    else:\n      - id: only\n        agent: x\n',
      'global',
    );
    if (!parsed.ok) {
      throw new Error(parsed.error.issues.join('; '));
    }
    const [check] = parsed.value.steps;
    expect(check).toMatchObject({ then: { kind: 'steps', steps: [] } });
  });

  it("allows a gate inside a condition's lane - only one side runs - but not when that condition sits under a fork", () => {
    const gate = parseWorkflowDefinition(
      'name: x\nsteps:\n  - id: c\n    if: a.b\n    then:\n      - id: g\n        gate: approve\n        show: [a]\n',
      'global',
    );
    if (!gate.ok) {
      throw new Error(gate.error.issues.join('; '));
    }
    expect(gate.value.steps[0]).toMatchObject({
      kind: 'condition',
      then: { kind: 'steps', steps: [{ kind: 'gate', gate: 'approve', id: 'g', show: ['a'] }] },
    });
    // round-trips: the gate serializes inside the then list
    const reparsed = parseWorkflowDefinition(serializeWorkflowDefinition(gate.value), 'global');
    expect(reparsed.ok && reparsed.value.steps).toEqual(gate.value.steps);

    const underFork = parseWorkflowDefinition(
      [
        'name: x',
        'steps:',
        '  - id: p',
        '    parallel:',
        '      - id: c',
        '        if: a.b',
        '        then:',
        '          - id: g',
        '            gate: approve',
        '      - id: a',
        '        agent: someone',
      ].join('\n'),
      'global',
    );
    expect(!underFork.ok && underFork.error.issues.join(' ')).toContain(
      'sibling branches are mid-flight',
    );

    const forEach = parseWorkflowDefinition(
      'name: x\nsteps:\n  - id: c\n    if: a.b\n    then:\n      - id: f\n        for_each: a.items\n        do:\n          agent: x\n',
      'global',
    );
    expect(!forEach.ok && forEach.error.issues.join(' ')).toContain(
      "for_each can't nest inside a branch",
    );
  });

  it("parses goto / finish / fail flow steps, round-trips them, and keeps while's own goto key", () => {
    const source = [
      'name: x',
      'steps:',
      '  - id: fix',
      '    agent: fixer',
      '  - id: check',
      '    if: result.blocking',
      '    then:',
      '      - id: retry',
      '        goto: fix',
      '        max_loops: 2',
      '      - id: bail',
      '        fail: still red after retries',
      '  - id: again',
      '    while: result.blocking',
      '    goto: fix',
      '  - id: done',
      '    finish: run',
    ].join('\n');
    const parsed = parseWorkflowDefinition(source, 'global');
    if (!parsed.ok) {
      throw new Error(parsed.error.issues.join('; '));
    }
    expect(parsed.value.steps.map((step) => step.kind)).toEqual([
      'agent',
      'condition',
      'while',
      'finish',
    ]);
    expect(parsed.value.steps[1]).toMatchObject({
      then: {
        kind: 'steps',
        steps: [
          { kind: 'goto', id: 'retry', targetStepId: 'fix', maxLoops: 2 },
          { kind: 'fail', id: 'bail', message: 'still red after retries' },
        ],
      },
    });
    const reparsed = parseWorkflowDefinition(serializeWorkflowDefinition(parsed.value), 'global');
    expect(reparsed.ok && reparsed.value.steps).toEqual(parsed.value.steps);

    // a goto may target its own lane or the enclosing pipeline - never nothing
    const unknown = parseWorkflowDefinition(
      'name: x\nsteps:\n  - id: c\n    if: a.b\n    then:\n      - id: j\n        goto: nowhere\n',
      'global',
    );
    expect(!unknown.ok && unknown.error.issues.join(' ')).toContain(
      "targets unknown step 'nowhere'",
    );

    // nothing outside a fork is reachable, and flow steps can't live under one at all
    const underFork = parseWorkflowDefinition(
      'name: x\nsteps:\n  - id: a\n    agent: someone\n  - id: p\n    parallel:\n      - id: j\n        goto: a\n      - id: b\n        agent: someone\n',
      'global',
    );
    expect(!underFork.ok && underFork.error.issues.join(' ')).toContain(
      "a goto step can't run inside a parallel branch",
    );
  });

  it('rejects an output alias that shadows another step (results are registered under id AND alias)', () => {
    const sameAlias = parseWorkflowDefinition(
      'name: x\nsteps:\n  - id: a\n    agent: one\n    output: findings\n  - id: b\n    agent: two\n    output: findings\n',
      'global',
    );
    expect(!sameAlias.ok && sameAlias.error.issues.join(' ')).toContain(
      "Output name 'findings' on step 'b' collides with step 'a'",
    );

    const aliasIsAnId = parseWorkflowDefinition(
      'name: x\nsteps:\n  - id: plan\n    agent: one\n  - id: b\n    script: pnpm test\n    output: plan\n',
      'global',
    );
    expect(!aliasIsAnId.ok && aliasIsAnId.error.issues.join(' ')).toContain(
      "Output name 'plan' on step 'b' collides with step 'plan'",
    );

    // an alias equal to the step's own id is just redundant, not a collision
    const ownId = parseWorkflowDefinition(
      'name: x\nsteps:\n  - id: plan\n    agent: one\n    output: plan\n',
      'global',
    );
    expect(ownId.ok).toBe(true);
  });

  it('condition/while nest inside a parallel branch, scoped to that branch', () => {
    const source = [
      'name: x',
      'steps:',
      '  - id: p',
      '    parallel:',
      '      - - id: check',
      '          if: a.b',
      '          then:',
      '            - id: inner',
      '              agent: x',
      '      - id: b',
      '        agent: y',
      '',
    ].join('\n');
    const parsed = parseWorkflowDefinition(source, 'global');
    if (!parsed.ok) {
      throw new Error(parsed.error.issues.join('; '));
    }
    const [fork] = parsed.value.steps;
    expect(fork?.kind === 'parallel' && fork.children[0]?.[0]?.kind).toBe('condition');
  });

  it('scopes a nested condition/while goto to its own branch, not the outer pipeline', () => {
    const source = [
      'name: x',
      'steps:',
      '  - id: p',
      '    parallel:',
      '      - - id: check',
      '          if: a.b',
      '          then: p', // 'p' is the outer fork, not visible inside this branch
      '      - id: b',
      '        agent: y',
      '',
    ].join('\n');
    const parsed = parseWorkflowDefinition(source, 'global');
    expect(!parsed.ok && parsed.error.issues.join(' ')).toContain("targets unknown step 'p'");
  });

  it('parallel branches accept both a bare step (single-step shorthand) and a nested sequence (chain), and round-trip', () => {
    const source = [
      'name: x',
      'steps:',
      '  - id: p',
      '    parallel:',
      '      - id: solo',
      '        agent: one',
      '      - - id: first',
      '          agent: two',
      '        - id: second',
      '          agent: three',
      '          input: [first]',
      '',
    ].join('\n');
    const parsed = parseWorkflowDefinition(source, 'global');
    if (!parsed.ok) {
      throw new Error(parsed.error.issues.join('; '));
    }
    const [fork] = parsed.value.steps;
    expect(
      fork?.kind === 'parallel' && fork.children.map((branch) => branch.map((s) => s.id)),
    ).toEqual([['solo'], ['first', 'second']]);
    const reparsed = parseWorkflowDefinition(serializeWorkflowDefinition(parsed.value), 'global');
    if (!reparsed.ok) {
      throw new Error(reparsed.error.issues.join('; '));
    }
    expect(reparsed.value.steps).toEqual(parsed.value.steps);
  });
});

describe('secrets', () => {
  it('parses the declaration with optional markers and hands each step its list, round-tripping', () => {
    const source = [
      'name: x',
      'secrets: [GH_TOKEN, JIRA_API_TOKEN?]',
      'steps:',
      '  - id: facts',
      '    script: github-pr-facts',
      '    secrets: [GH_TOKEN]',
      '  - id: history',
      '    agent: review-history',
      '    secrets: [GH_TOKEN, JIRA_API_TOKEN]',
      '',
    ].join('\n');
    const parsed = parseWorkflowDefinition(source, 'global');
    if (!parsed.ok) {
      throw new Error(parsed.error.issues.join('; '));
    }
    expect(parsed.value.secrets).toEqual([
      { name: 'GH_TOKEN', required: true },
      { name: 'JIRA_API_TOKEN', required: false },
    ]);
    expect(parsed.value.steps[0]).toMatchObject({ kind: 'script', secrets: ['GH_TOKEN'] });
    expect(parsed.value.steps[1]).toMatchObject({
      kind: 'agent',
      secrets: ['GH_TOKEN', 'JIRA_API_TOKEN'],
    });
    const yaml = serializeWorkflowDefinition(parsed.value);
    expect(yaml).toContain('secrets:\n  - GH_TOKEN\n  - JIRA_API_TOKEN?');
    const again = parseWorkflowDefinition(yaml, 'global');
    expect(again.ok && again.value).toEqual(parsed.value);
  });

  it('refuses names that are not environment-variable shaped, and duplicates', () => {
    const bad = parseWorkflowDefinition(
      'name: x\nsecrets: [gh-token, GH_TOKEN, GH_TOKEN?]\nsteps:\n  - id: a\n    agent: someone\n',
      'global',
    );
    const issues = !bad.ok ? bad.error.issues.join(' ') : '';
    expect(issues).toContain("'gh-token'");
    expect(issues).toContain("'GH_TOKEN' is declared twice");
  });
});

describe('env pass-through', () => {
  it('parses and round-trips env:, and refuses a declared secret there', () => {
    const parsed = parseWorkflowDefinition(
      'name: x\nsecrets: [GH_TOKEN]\nenv: [HTTP_PROXY, NODE_OPTIONS, HTTP_PROXY]\nsteps:\n  - id: a\n    agent: someone\n    secrets: [GH_TOKEN]\n',
      'global',
    );
    if (!parsed.ok) throw new Error(parsed.error.issues.join('; '));
    expect(parsed.value.env).toEqual(['HTTP_PROXY', 'NODE_OPTIONS']);
    expect(serializeWorkflowDefinition(parsed.value)).toContain(
      'env:\n  - HTTP_PROXY\n  - NODE_OPTIONS',
    );

    const clash = parseWorkflowDefinition(
      'name: x\nsecrets: [GH_TOKEN]\nenv: [GH_TOKEN, 9BAD]\nsteps:\n  - id: a\n    agent: someone\n    secrets: [GH_TOKEN]\n',
      'global',
    );
    const issues = !clash.ok ? clash.error.issues.join(' ') : '';
    expect(issues).toContain("'GH_TOKEN' is a declared secret");
    expect(issues).toContain("'9BAD' is not an environment variable name");
  });
});

describe('gate choice default', () => {
  it('parses default: true, round-trips it, and refuses two defaults', () => {
    const source =
      'name: x\nsteps:\n  - id: a\n    agent: someone\n    output: a\n  - id: g\n    gate: choice\n    show: [a]\n    choices:\n      - { id: post, label: Post, default: true }\n      - { id: none, label: Done, needs: none }\n';
    const parsed = parseWorkflowDefinition(source, 'global');
    if (!parsed.ok) throw new Error(parsed.error.issues.join('; '));
    const gate = parsed.value.steps[1];
    expect(gate?.kind === 'gate' && gate.choices).toEqual([
      { id: 'post', label: 'Post', needs: 'selection', default: true },
      { id: 'none', label: 'Done', needs: 'none' },
    ]);
    expect(serializeWorkflowDefinition(parsed.value)).toContain('default: true');
    const two = parseWorkflowDefinition(
      source.replace('needs: none }', 'needs: none, default: true }'),
      'global',
    );
    expect(!two.ok && two.error.issues.join(' ')).toContain('only one choice can be the default');
  });
});

describe('declared inputs and outputs', () => {
  it('parses inputs as specs or plain examples, finish/fail with input and with, and round-trips', () => {
    const source = [
      'name: pr-review',
      'inputs:',
      '  pr: { type: text, description: The pull request to review }',
      '  focus: { type: text, required: false, description: What to look at first }',
      '  depth: { type: choice, options: [quick, deep], default: quick }',
      '  count: 3',
      '  verbose: false',
      'steps:',
      '  - id: facts',
      '    script: github-pr-facts',
      '    input: [inputs.pr]',
      '    output: facts',
      '  - id: done',
      '    finish: run',
      '    input: [facts]',
      '    with: { posted: $facts.url, _summary: all good }',
      '  - id: stale',
      '    fail: The PR moved',
      '    with: { headSha: $facts.headSha }',
      '',
    ].join('\n');
    const parsed = parseWorkflowDefinition(source, 'global');
    if (!parsed.ok) throw new Error(parsed.error.issues.join('; '));
    expect(parsed.value.inputs).toEqual([
      {
        name: 'pr',
        type: 'text',
        required: true,
        description: 'The pull request to review',
      },
      { name: 'focus', type: 'text', required: false, description: 'What to look at first' },
      {
        name: 'depth',
        type: 'choice',
        required: false,
        default: 'quick',
        options: ['quick', 'deep'],
      },
      { name: 'count', type: 'number', required: false, default: 3 },
      { name: 'verbose', type: 'boolean', required: false, default: false },
    ]);
    expect(parsed.value.steps[1]).toEqual({
      kind: 'finish',
      id: 'done',
      input: ['facts'],
      params: { posted: '$facts.url', _summary: 'all good' },
    });
    expect(parsed.value.steps[2]).toEqual({
      kind: 'fail',
      id: 'stale',
      message: 'The PR moved',
      params: { headSha: '$facts.headSha' },
    });
    const again = parseWorkflowDefinition(serializeWorkflowDefinition(parsed.value), 'global');
    expect(again.ok && again.value).toEqual(parsed.value);
  });

  it('refuses bad input names, choices without options, and unknown types', () => {
    const bad = parseWorkflowDefinition(
      'name: x\ninputs:\n  Bad-Name: { type: text }\n  pick: { type: choice }\n  what: { type: thing }\nsteps:\n  - id: a\n    agent: someone\n',
      'global',
    );
    const issues = !bad.ok ? bad.error.issues.join(' ') : '';
    expect(issues).toContain('inputs.Bad-Name');
    expect(issues).toContain('a choice input needs options');
    expect(issues).toContain('inputs.what');
  });
});
