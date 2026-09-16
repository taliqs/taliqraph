import { describe, expect, it } from 'vitest';
import { buildDefinitionSet } from '../definition-set';
import { outsidePackageReferences } from './package-references';

describe('outsidePackageReferences', () => {
  it('names what a package reaches for outside itself, and where that lives', () => {
    const agent = (name: string) =>
      `---\nname: ${name}\ndescription: ${name}\nengine: claude-code\nmodel: sonnet-5\neffort: low\ntools:\n  read: always\n  write: off\n  commands: off\n---\nPrompt ${name}.\n`;
    const set = buildDefinitionSet([
      {
        kind: 'agent',
        origin: 'global',
        filePath: '/lib/agents/loose.agent.md',
        content: agent('loose'),
      },
      {
        kind: 'workflow',
        origin: 'global',
        filePath: '/lib/workflows/a/workflow.yaml',
        packagePath: ['a'],
        content:
          'name: a\ntitle: a\nsteps:\n  - id: one\n    agent: own\n  - id: two\n    agent: loose\n  - id: three\n    agent: theirs\n  - id: sub\n    workflow: b\n',
      },
      {
        kind: 'agent',
        origin: 'global',
        filePath: '/lib/workflows/a/agents/own.agent.md',
        packagePath: ['a'],
        content: agent('own'),
      },
      {
        kind: 'workflow',
        origin: 'global',
        filePath: '/lib/workflows/b/workflow.yaml',
        packagePath: ['b'],
        content: 'name: b\ntitle: b\nsteps:\n  - id: one\n    agent: theirs\n',
      },
      {
        kind: 'agent',
        origin: 'global',
        filePath: '/lib/workflows/b/agents/theirs.agent.md',
        packagePath: ['b'],
        content: agent('theirs'),
      },
    ]);
    expect(
      outsidePackageReferences(set, 'a').map((ref) => [ref.kind, ref.name, ref.from, ref.via]),
    ).toEqual([
      ['agent', 'loose', [], 'a/two'],
      ['agent', 'theirs', ['b'], 'a/three'],
      ['workflow', 'b', ['b'], 'a/sub'],
    ]);
    expect(outsidePackageReferences(set, 'b')).toEqual([]);
  });
});
