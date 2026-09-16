import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSkillDefinition } from '../src/definitions/skill/parse-skill-definition';
import { parseWorkflowDefinition } from '../src/definitions/workflow/parse-workflow-definition';
import { parseAgentDefinition } from '../src/definitions/agent/parse-agent-definition';

/**
 * The skill ships in the package, so it is documentation the runner can check on
 * itself: it has to be a valid skill, and the workflows and agents it shows have
 * to be things this parser accepts. A key that gets renamed here fails the build
 * rather than teaching someone the old name.
 */
const source = readFileSync(join(import.meta.dirname, 'SKILL.md'), 'utf8');

/** Every fenced block of `lang`, in order. */
function blocks(lang: string): string[] {
  const found: string[] = [];
  const fence = new RegExp('^(`{3,})' + lang + '\\s*$', 'gm');
  let opener: RegExpExecArray | null;
  while ((opener = fence.exec(source)) !== null) {
    const ticks = opener[1] as string;
    const start = opener.index + opener[0].length + 1;
    const closer = source.indexOf(`\n${ticks}`, start);
    if (closer > start) {
      found.push(source.slice(start, closer));
      fence.lastIndex = closer;
    }
  }
  return found;
}

describe('the shipped skill', () => {
  it('is a skill this runner can load', () => {
    const parsed = parseSkillDefinition(source, 'global');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.name).toBe('taliqraph-workflows');
      expect(parsed.value.description.length).toBeGreaterThan(40);
    }
  });

  it('shows workflows that parse', () => {
    // The fragments illustrate single steps; only whole files carry both keys.
    const whole = blocks('yaml').filter((text) => /^name:/m.test(text) && /^steps:/m.test(text));
    expect(whole.length).toBeGreaterThanOrEqual(2);
    for (const text of whole) {
      const parsed = parseWorkflowDefinition(text, 'global');
      expect(
        parsed.ok ? null : `${parsed.error.message}: ${parsed.error.issues.join(', ')}`,
      ).toBeNull();
    }
  });

  it('shows an agent that parses', () => {
    const agents = blocks('markdown').filter((text) => text.trimStart().startsWith('---'));
    expect(agents.length).toBeGreaterThanOrEqual(1);
    for (const text of agents) {
      const parsed = parseAgentDefinition(text, 'global');
      expect(
        parsed.ok ? null : `${parsed.error.message}: ${parsed.error.issues.join(', ')}`,
      ).toBeNull();
    }
  });
});
