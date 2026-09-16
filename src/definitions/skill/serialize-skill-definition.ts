import { stringify as stringifyYaml } from 'yaml';
import type { SkillDefinition } from './skill-definition';

export function serializeSkillDefinition(skill: SkillDefinition): string {
  const frontmatter: Record<string, unknown> = {
    name: skill.name,
    description: skill.description,
  };
  return `---\n${stringifyYaml(frontmatter)}---\n\n${skill.body}\n`;
}
