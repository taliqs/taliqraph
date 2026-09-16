import type { Result } from '../../shared/types/result';
import { err, ok } from '../../shared/types/result';
import { splitFrontmatter } from '../../shared/utils/split-frontmatter';
import { errorMessage } from '../../shared/utils/error-message';
import { parse as parseYaml } from 'yaml';
import type { DefinitionParseError } from '../definition-parse-error';
import { definitionParseError } from '../definition-parse-error';
import { formatZodIssues } from '../format-zod-issues';
import type { DefinitionScope } from '../scope';
import type { AgentDefinition, ToolPolicy } from './agent-definition';
import type { AgentFrontmatter } from './agent-frontmatter-schema';
import { agentFrontmatterSchema } from './agent-frontmatter-schema';

export function parseAgentDefinition(
  source: string,
  scope: DefinitionScope,
): Result<AgentDefinition, DefinitionParseError> {
  const split = splitFrontmatter(source);
  if (!split) {
    return err(definitionParseError('Agent file is missing its frontmatter block (--- ... ---)'));
  }

  let rawFrontmatter: unknown;
  try {
    rawFrontmatter = parseYaml(split.frontmatter);
  } catch (cause) {
    return err(definitionParseError(`Agent frontmatter is not valid YAML: ${errorMessage(cause)}`));
  }

  const parsed = agentFrontmatterSchema.safeParse(rawFrontmatter);
  if (!parsed.success) {
    return err(definitionParseError('Agent frontmatter is invalid', formatZodIssues(parsed.error)));
  }

  const body = splitReportSection(split.body);
  if (!body.ok) {
    return err(body.error);
  }
  if (body.value.prompt.length === 0) {
    return err(definitionParseError('Agent prompt body is empty'));
  }

  return ok(toAgentDefinition(parsed.data, body.value.prompt, body.value.reportExample, scope));
}

const REPORT_HEADING = /^##\s*Report\s*$/im;

/**
 * The body's optional `## Report` section carries the JSON skeleton the agent
 * must end its reply with. It is kept apart from the prompt so editing behavior
 * can't break the wire contract the orchestrator parses.
 */
function splitReportSection(
  body: string,
): Result<{ prompt: string; reportExample?: string }, DefinitionParseError> {
  const heading = REPORT_HEADING.exec(body);
  if (!heading) {
    return ok({ prompt: body.trim() });
  }
  const prompt = body.slice(0, heading.index).trim();
  const after = body.slice(heading.index + heading[0].length);
  const fence = /```json\s*\n([\s\S]*?)```/.exec(after);
  if (!fence) {
    return err(definitionParseError('The ## Report section must contain a fenced ```json block'));
  }
  const reportExample = (fence[1] ?? '').trim();
  try {
    JSON.parse(reportExample);
  } catch (cause) {
    return err(
      definitionParseError('The ## Report example is not valid JSON', [errorMessage(cause)]),
    );
  }
  return ok({ prompt, reportExample });
}

function toAgentDefinition(
  frontmatter: AgentFrontmatter,
  prompt: string,
  reportExample: string | undefined,
  scope: DefinitionScope,
): AgentDefinition {
  return {
    name: frontmatter.name,
    description: frontmatter.description,
    engine: frontmatter.engine,
    model: frontmatter.model,
    effort: frontmatter.effort,
    tools: toToolPolicy(frontmatter.tools),
    ...(frontmatter.skills.length > 0 ? { skills: frontmatter.skills } : {}),
    scope,
    prompt,
    ...(reportExample ? { reportExample } : {}),
  };
}

function toToolPolicy(tools: AgentFrontmatter['tools']): ToolPolicy {
  return {
    read: tools.read,
    write: tools.write,
    commands: tools.commands,
    commandAllowlist: tools.allowlist,
    network: tools.network,
    mcp: tools.mcp,
  };
}
