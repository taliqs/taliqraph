import { stringify as stringifyYaml } from 'yaml';
import type { AgentDefinition } from './agent-definition';

/**
 * Renders an AgentDefinition back into its on-disk `.agent.md` form, the
 * inverse of parseAgentDefinition. Scope is implied by file location and
 * never serialized. Structured saves normalize formatting; hand-written
 * comments in the frontmatter do not survive them.
 */
export function serializeAgentDefinition(agent: AgentDefinition): string {
  const tools: Record<string, unknown> = {
    read: agent.tools.read,
    write: agent.tools.write,
    commands: agent.tools.commands,
    ...(agent.tools.commands === 'allowlist' || agent.tools.commandAllowlist.length > 0
      ? { allowlist: [...agent.tools.commandAllowlist] }
      : {}),
    network: agent.tools.network,
    ...(agent.tools.mcp.length > 0 ? { mcp: [...agent.tools.mcp] } : {}),
  };

  const frontmatter: Record<string, unknown> = {
    name: agent.name,
    description: agent.description,
    engine: agent.engine,
    model: agent.model,
    effort: agent.effort,
    tools,
    ...(agent.skills && agent.skills.length > 0 ? { skills: [...agent.skills] } : {}),
  };

  const yaml = stringifyYaml(frontmatter, { lineWidth: 0 }).trimEnd();
  const report = agent.reportExample
    ? `\n\n## Report\n\n\`\`\`json\n${agent.reportExample.trim()}\n\`\`\``
    : '';
  return `---\n${yaml}\n---\n${agent.prompt.trim()}${report}\n`;
}
