import type { Result } from '../../shared/types/result';
import { err, ok } from '../../shared/types/result';
import { splitFrontmatter } from '../../shared/utils/split-frontmatter';
import { errorMessage } from '../../shared/utils/error-message';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { DefinitionParseError } from '../definition-parse-error';
import { definitionParseError } from '../definition-parse-error';
import { formatZodIssues } from '../format-zod-issues';
import type { DefinitionScope } from '../scope';
import type { SkillDefinition } from './skill-definition';

/**
 * SKILL.md-compatible: name + description are the ecosystem contract; extra
 * frontmatter keys (argument-hint, license, our match) pass through unbothered.
 */
const skillFrontmatterSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().min(1),
  })
  .passthrough();

export function parseSkillDefinition(
  source: string,
  scope: DefinitionScope,
): Result<SkillDefinition, DefinitionParseError> {
  const split = splitFrontmatter(source);
  if (!split) {
    return err(definitionParseError('Skill file is missing its frontmatter block (--- ... ---)'));
  }
  let raw: unknown;
  try {
    raw = parseYaml(split.frontmatter);
  } catch (cause) {
    return err(definitionParseError(`Skill frontmatter is not valid YAML: ${errorMessage(cause)}`));
  }
  const parsed = skillFrontmatterSchema.safeParse(raw);
  if (!parsed.success) {
    return err(definitionParseError('Skill frontmatter is invalid', formatZodIssues(parsed.error)));
  }
  const body = split.body.trim();
  if (body.length === 0) {
    return err(definitionParseError('Skill instructions are empty'));
  }
  return ok({
    name: parsed.data.name,
    description: parsed.data.description,
    scope,
    body,
  });
}
