import type { SkillDefinition } from './skill-definition';

const MAX_SKILLS_CHARS = 12_000;

/**
 * The prompt section for a step's attached skills (the ones the agent lists
 * under skills:), capped so a fat skill cannot crowd out the actual work.
 */
export function renderSkillsFor(
  skills: Iterable<SkillDefinition>,
  options: { readonly explicit: readonly string[] },
): string | undefined {
  const attached = [...skills].filter((skill) => options.explicit.includes(skill.name));
  if (attached.length === 0) {
    return undefined;
  }
  let budget = MAX_SKILLS_CHARS;
  const sections: string[] = [];
  for (const skill of attached) {
    const section = `## Skill: ${skill.name}\n${skill.body}`;
    if (section.length > budget) {
      continue;
    }
    budget -= section.length;
    sections.push(section);
  }
  return sections.length > 0
    ? `# Skills - procedures to follow where relevant\n\n${sections.join('\n\n')}`
    : undefined;
}
