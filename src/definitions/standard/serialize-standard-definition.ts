import { stringify as stringifyYaml } from 'yaml';
import type { StandardDefinition } from './standard-definition';

/** Renders a StandardDefinition back into its on-disk `.md` form, the inverse of the parser. */
export function serializeStandardDefinition(standard: StandardDefinition): string {
  const frontmatter: Record<string, unknown> = {
    name: standard.name,
    ...(standard.description ? { description: standard.description } : {}),
    ...(standard.appliesTo.length > 0 ? { applies_to: [...standard.appliesTo] } : {}),
  };
  const yaml = stringifyYaml(frontmatter, { lineWidth: 0 }).trimEnd();
  return `---\n${yaml}\n---\n${standard.body.trim()}\n`;
}
