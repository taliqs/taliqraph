import type { AgentDefinition } from '../agent/agent-definition';
import type { WorkflowDefinition } from './workflow-definition';
import type { WorkflowStep } from './workflow-step';

/** One MCP server a workflow's agents name under tools.mcp; `name?` marks it optional. */
export interface McpRequirement {
  readonly name: string;
  readonly optional: boolean;
  /** The agents that list it. */
  readonly agents: readonly string[];
}

/** `github?` → { name: 'github', optional: true }. */
export function parseMcpName(raw: string): { name: string; optional: boolean } {
  const optional = raw.endsWith('?');
  return { name: optional ? raw.slice(0, -1) : raw, optional };
}

/**
 * The MCP servers a workflow needs, derived from its agents (and its
 * sub-workflows' agents): the requirement lives where the tool is used, not
 * in a second list on the workflow. Required wins over optional when both
 * appear for one name.
 */
export function requiredMcpServers(
  workflow: WorkflowDefinition,
  resolveAgent: (name: string) => Pick<AgentDefinition, 'tools'> | undefined,
  resolveWorkflow: (name: string) => WorkflowDefinition | undefined,
): McpRequirement[] {
  const byName = new Map<string, { optional: boolean; agents: Set<string> }>();
  const seen = new Set<string>();
  const useAgent = (agentName: string): void => {
    for (const raw of resolveAgent(agentName)?.tools.mcp ?? []) {
      const { name, optional } = parseMcpName(raw);
      const entry = byName.get(name) ?? { optional, agents: new Set<string>() };
      entry.optional = entry.optional && optional;
      entry.agents.add(agentName);
      byName.set(name, entry);
    }
  };
  const visitSteps = (steps: readonly WorkflowStep[]): void => {
    for (const step of steps) {
      switch (step.kind) {
        case 'agent':
          useAgent(step.agent);
          break;
        case 'foreach':
          useAgent(step.template.agent);
          break;
        case 'workflow': {
          const child = resolveWorkflow(step.workflow);
          if (child && !seen.has(child.name)) {
            seen.add(child.name);
            visitSteps(child.steps);
          }
          break;
        }
        case 'parallel':
          for (const branch of step.children) {
            visitSteps(branch);
          }
          break;
        case 'condition':
          if (step.then.kind === 'steps') {
            visitSteps(step.then.steps);
          }
          if (step.else?.kind === 'steps') {
            visitSteps(step.else.steps);
          }
          break;
        default:
          break;
      }
    }
  };
  seen.add(workflow.name);
  visitSteps(workflow.steps);
  return [...byName.entries()].map(([name, entry]) => ({
    name,
    optional: entry.optional,
    agents: [...entry.agents],
  }));
}

export function describeMissingMcpServers(
  workflowName: string,
  missing: readonly McpRequirement[],
): string {
  const list = missing
    .map((requirement) => `'${requirement.name}' (agent ${requirement.agents.join(', ')})`)
    .join(', ');
  return `${workflowName} needs ${missing.length === 1 ? 'the MCP server' : 'MCP servers'} ${list} - offer it to the run, or mark it optional in the agent (tools.mcp: [${missing[0]?.name}?]).`;
}
