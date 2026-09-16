import { describe, expect, it } from 'vitest';
import { parseSkillDefinition } from './parse-skill-definition';
import { renderSkillsFor } from './render-skills-for';
import { serializeSkillDefinition } from './serialize-skill-definition';

const SOURCE = `---
name: release-process
description: How releases are cut in this org.
argument-hint: "version"
match: [release, changelog]
---

1. Bump the version.
2. Update CHANGELOG.md.
`;

describe('skills', () => {
  it('parses the ecosystem SKILL.md format, extra frontmatter keys pass through', () => {
    const parsed = parseSkillDefinition(SOURCE, 'global');
    if (!parsed.ok) {
      throw new Error(parsed.error.message);
    }
    expect(parsed.value).toMatchObject({
      name: 'release-process',
      description: 'How releases are cut in this org.',
    });
    expect(parsed.value.body).toContain('Bump the version');
  });

  it('round-trips through serialize', () => {
    const parsed = parseSkillDefinition(SOURCE, 'global');
    if (!parsed.ok) {
      throw new Error('parse failed');
    }
    const reparsed = parseSkillDefinition(serializeSkillDefinition(parsed.value), 'global');
    expect(reparsed.ok && reparsed.value.name).toBe('release-process');
  });

  it('rejects files without frontmatter, name, description, or body', () => {
    expect(parseSkillDefinition('just prose', 'global').ok).toBe(false);
    expect(parseSkillDefinition('---\nname: x\n---\n\nbody', 'global').ok).toBe(false); // no description
    expect(parseSkillDefinition('---\nname: x\ndescription: y\n---\n\n', 'global').ok).toBe(false); // empty body
  });

  it('attaches only the skills an agent lists explicitly, capped', () => {
    const skill = parseSkillDefinition(SOURCE, 'global');
    if (!skill.ok) {
      throw new Error('parse failed');
    }
    const skills = [skill.value];
    expect(renderSkillsFor(skills, { explicit: ['release-process'] })).toContain(
      'Skill: release-process',
    );
    expect(renderSkillsFor(skills, { explicit: [] })).toBeUndefined();
  });
});
