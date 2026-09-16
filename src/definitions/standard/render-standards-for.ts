import type { StandardDefinition } from './standard-definition';

const DEFAULT_CAP = 4_000;

/**
 * The injectable standards text for one agent: every standard whose
 * `applies_to` names it (or is empty), concatenated and capped so a pile of
 * rules can't crowd out the actual task.
 */
export function renderStandardsFor(
  standards: Iterable<StandardDefinition>,
  agentName: string,
  cap = DEFAULT_CAP,
): string | undefined {
  const sections: string[] = [];
  for (const standard of standards) {
    if (standard.appliesTo.length > 0 && !standard.appliesTo.includes(agentName)) {
      continue;
    }
    sections.push(`## ${standard.name}\n${standard.body.trim()}`);
  }
  if (sections.length === 0) {
    return undefined;
  }
  const text = sections.join('\n\n');
  return text.length <= cap ? text : `${text.slice(0, cap)}\n… (standards truncated)`;
}
