import { describe, expect, it } from 'vitest';
import { parseStandardDefinition } from './parse-standard-definition';
import { renderStandardsFor } from './render-standards-for';
import { serializeStandardDefinition } from './serialize-standard-definition';
import type { StandardDefinition } from './standard-definition';

const SOURCE = `---
name: commit-style
description: How commits are written here.
applies_to: [software-engineer, task-assistant]
---
- Imperative mood, no trailing period.
- Reference the ticket when one exists.
`;

describe('standard definitions', () => {
  it('parses frontmatter and rule body', () => {
    const parsed = parseStandardDefinition(SOURCE, 'global');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.name).toBe('commit-style');
      expect(parsed.value.appliesTo).toEqual(['software-engineer', 'task-assistant']);
      expect(parsed.value.body).toContain('Imperative mood');
    }
  });

  it('rejects an empty rule body', () => {
    const parsed = parseStandardDefinition('---\nname: x\n---\n', 'global');
    expect(parsed.ok).toBe(false);
  });

  it('roundtrips through the serializer', () => {
    const standard: StandardDefinition = {
      name: 'naming',
      description: 'Naming rules.',
      appliesTo: ['software-engineer'],
      scope: 'project',
      body: 'Events are past-tense verbs.',
    };
    const parsed = parseStandardDefinition(serializeStandardDefinition(standard), 'project');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value).toEqual(standard);
    }
  });

  it('renders only the standards that apply to an agent, capped', () => {
    const anyAgent: StandardDefinition = {
      name: 'general',
      appliesTo: [],
      scope: 'global',
      body: 'Be tidy.',
    };
    const engineerOnly: StandardDefinition = {
      name: 'testing',
      appliesTo: ['software-engineer'],
      scope: 'global',
      body: 'Tests live next to the code.',
    };
    expect(renderStandardsFor([anyAgent, engineerOnly], 'software-engineer')).toContain(
      '## testing',
    );
    expect(renderStandardsFor([anyAgent, engineerOnly], 'investigator')).not.toContain(
      '## testing',
    );
    expect(renderStandardsFor([engineerOnly], 'investigator')).toBeUndefined();
    expect(renderStandardsFor([anyAgent], 'x', 4)).toContain('truncated');
  });
});
