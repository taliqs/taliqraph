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
import type { StandardDefinition } from './standard-definition';

const standardFrontmatterSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1).optional(),
  applies_to: z.array(z.string()).default([]),
});

export function parseStandardDefinition(
  source: string,
  scope: DefinitionScope,
): Result<StandardDefinition, DefinitionParseError> {
  const split = splitFrontmatter(source);
  if (!split) {
    return err(
      definitionParseError('Standard file is missing its frontmatter block (--- ... ---)'),
    );
  }

  let raw: unknown;
  try {
    raw = parseYaml(split.frontmatter);
  } catch (cause) {
    return err(
      definitionParseError(`Standard frontmatter is not valid YAML: ${errorMessage(cause)}`),
    );
  }

  const parsed = standardFrontmatterSchema.safeParse(raw);
  if (!parsed.success) {
    return err(
      definitionParseError('Standard frontmatter is invalid', formatZodIssues(parsed.error)),
    );
  }

  const body = split.body.trim();
  if (body.length === 0) {
    return err(definitionParseError('Standard rule text is empty'));
  }

  return ok({
    name: parsed.data.name,
    ...(parsed.data.description ? { description: parsed.data.description } : {}),
    appliesTo: parsed.data.applies_to,
    scope,
    body,
  });
}
