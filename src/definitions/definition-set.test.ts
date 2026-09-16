import { describe, expect, it } from 'vitest';
import type { DefinitionSource } from './definition-set';
import { buildDefinitionSet, packageScope } from './definition-set';

const agentSource = (name: string, description: string): string => `---
name: ${name}
description: ${description}
engine: claude-code
model: sonnet-5
effort: med
tools:
  read: always
  write: off
  commands: off
  network: off
---
Prompt for ${name}.
`;

const workflowSource = (name: string, extra = ''): string => `
name: ${name}
title: ${name}
${extra}steps:
  - id: investigate
    agent: investigator
    output: findings
  - id: approve
    gate: approve
    show: findings
`;

const src = (
  kind: 'agent' | 'workflow',
  origin: DefinitionSource['origin'],
  content: string,
  filePath?: string,
): DefinitionSource => ({ kind, origin, content, ...(filePath ? { filePath } : {}) });

describe('buildDefinitionSet', () => {
  it('later layers shadow earlier ones and carry their origin', () => {
    const set = buildDefinitionSet([
      src('agent', 'built-in', agentSource('investigator', 'built-in version')),
      src('agent', 'global', agentSource('investigator', 'my version'), '/g/investigator.agent.md'),
      src('agent', 'global', agentSource('planner', 'untouched'), '/g/planner.agent.md'),
      src(
        'agent',
        'project',
        agentSource('planner', 'project version'),
        '/repo/.taliqraph/agents/planner.agent.md',
      ),
    ]);

    expect(set.problems).toEqual([]);
    expect(set.agents.get('investigator')?.definition.description).toBe('my version');
    expect(set.agents.get('investigator')?.origin).toBe('global');
    expect(set.agents.get('planner')?.origin).toBe('project');
    expect(set.agents.get('planner')?.filePath).toBe('/repo/.taliqraph/agents/planner.agent.md');
  });

  it('an invalid file becomes a problem and shadows nothing', () => {
    const set = buildDefinitionSet([
      src('agent', 'built-in', agentSource('investigator', 'built-in version')),
      src('agent', 'global', '---\nname: investigator\n---\nbroken', '/g/investigator.agent.md'),
    ]);

    expect(set.problems).toHaveLength(1);
    expect(set.problems[0]?.filePath).toBe('/g/investigator.agent.md');
    expect(set.agents.get('investigator')?.origin).toBe('built-in'); // survived
  });

  it('resolves extends: matching ids replace in place, new steps append', () => {
    const child = `
name: my-dev
title: My Dev
extends: base-dev
steps:
  - id: investigate
    agent: my-investigator
    output: findings
  - id: ship
    script: github-create-pr
`;
    const set = buildDefinitionSet([
      src('workflow', 'built-in', workflowSource('base-dev', 'match: [fix]\n')),
      src('workflow', 'global', child, '/g/my-dev.workflow.yaml'),
    ]);

    expect(set.problems).toEqual([]);
    const merged = set.workflows.get('my-dev')?.definition;
    expect(merged?.steps.map((step) => step.id)).toEqual(['investigate', 'approve', 'ship']);
    const first = merged?.steps[0];
    expect(first?.kind === 'agent' && first.agent).toBe('my-investigator'); // replaced in place
  });

  it('reports a missing extends base and drops the workflow', () => {
    const set = buildDefinitionSet([
      src(
        'workflow',
        'global',
        `name: lonely\ntitle: Lonely\nextends: ghost\nsteps:\n  - id: a\n    agent: x\n`,
        '/g/lonely.workflow.yaml',
      ),
    ]);
    expect(set.workflows.has('lonely')).toBe(false);
    expect(set.problems[0]?.message).toContain("extends 'ghost'");
  });

  it('reports extends cycles', () => {
    const cyclic = (name: string, base: string): string =>
      `name: ${name}\ntitle: ${name}\nextends: ${base}\nsteps:\n  - id: a\n    agent: x\n`;
    const set = buildDefinitionSet([
      src('workflow', 'global', cyclic('a', 'b'), '/g/a.yaml'),
      src('workflow', 'global', cyclic('b', 'a'), '/g/b.yaml'),
    ]);
    expect(set.workflows.size).toBe(0);
    expect(set.problems.some((problem) => problem.message.includes('cycle'))).toBe(true);
  });
});

describe('workflow packages', () => {
  const agent = (name: string) =>
    `---\nname: ${name}\ndescription: ${name}\nengine: claude-code\nmodel: sonnet-5\neffort: low\ntools:\n  read: always\n  write: off\n  commands: off\n---\nPrompt ${name}.\n`;
  const workflow = (name: string, agentName: string, nested?: string) =>
    `name: ${name}\ntitle: ${name}\nsteps:\n  - id: look\n    agent: ${agentName}\n${nested ? `  - id: sub\n    workflow: ${nested}\n` : ''}`;

  it('groups sources into packages, keeps the shelf apart, and scopes a run to its package', () => {
    const set = buildDefinitionSet([
      {
        kind: 'agent',
        origin: 'global',
        filePath: '/lib/agents/spare.agent.md',
        content: agent('spare'),
      },
      {
        kind: 'workflow',
        origin: 'global',
        filePath: '/lib/workflows/a/workflow.yaml',
        packagePath: ['a'],
        content: workflow('a', 'worker', 'b'),
      },
      {
        kind: 'agent',
        origin: 'global',
        filePath: '/lib/workflows/a/agents/worker.agent.md',
        packagePath: ['a'],
        content: agent('worker'),
      },
      {
        kind: 'workflow',
        origin: 'global',
        filePath: '/lib/workflows/a/workflows/b/workflow.yaml',
        packagePath: ['a', 'b'],
        content: workflow('b', 'checker'),
      },
      {
        kind: 'agent',
        origin: 'global',
        filePath: '/lib/workflows/a/workflows/b/agents/checker.agent.md',
        packagePath: ['a', 'b'],
        content: agent('checker'),
      },
      {
        kind: 'workflow',
        origin: 'project',
        filePath: '/repo/.taliqraph/workflows/c/workflow.yaml',
        packagePath: ['c'],
        content: workflow('c', 'worker'),
      },
      {
        kind: 'agent',
        origin: 'project',
        filePath: '/repo/.taliqraph/workflows/c/agents/worker.agent.md',
        packagePath: ['c'],
        content: agent('worker').replace('Prompt worker.', 'Other worker.'),
      },
    ]);
    expect(set.problems).toEqual([]);
    expect([...set.packages.keys()]).toEqual(['a', 'c']);
    const a = set.packages.get('a');
    expect(a?.dir).toBe('/lib/workflows/a');
    expect([...(a?.agents.keys() ?? [])]).toEqual(['worker']);
    expect(a?.workflows.get('b')?.agents.has('checker')).toBe(true);
    expect(set.packages.get('c')?.origin).toBe('project');
    expect([...set.pieces.agents.keys()]).toEqual(['spare']);

    // each package sees its own copy; nested members and the shelf are in scope, siblings' members are not
    const scopeA = packageScope(set, 'a');
    expect(scopeA.agents.get('worker')?.prompt).toBe('Prompt worker.');
    expect(scopeA.agents.has('checker')).toBe(true);
    expect(scopeA.agents.has('spare')).toBe(true);
    expect(scopeA.workflows.has('b')).toBe(true);
    expect(packageScope(set, 'c').agents.get('worker')?.prompt).toBe('Other worker.');
    // the union view lists one name once - the last package wins; packages are the source of truth
    expect(set.agents.get('worker')?.packagePath).toEqual(['c']);
  });
});
