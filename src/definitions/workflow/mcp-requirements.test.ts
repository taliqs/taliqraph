import { describe, expect, it } from 'vitest';
import type { AgentDefinition } from '../agent/agent-definition';
import { lintWorkflow } from './lint-workflow';
import { describeMissingMcpServers, parseMcpName, requiredMcpServers } from './mcp-requirements';
import { parseWorkflowDefinition } from './parse-workflow-definition';

const SOURCE = `
name: needs-mcp
title: Needs MCP
inputs:
  prompt: ''
steps:
  - id: look
    agent: looker
    input: [inputs.prompt]
    output: seen
  - id: nested
    workflow: inner
  - id: fan
    parallel:
      - - id: a
          agent: looker
      - - id: b
          agent: poster
`;
const INNER = `
name: inner
title: Inner
steps:
  - id: deep
    agent: deep-agent
`;

const withMcp = (mcp: readonly string[]): Pick<AgentDefinition, 'tools'> => ({
  tools: {
    read: 'always',
    write: 'off',
    commands: 'off',
    commandAllowlist: [],
    network: 'off',
    mcp,
  },
});
const agents = new Map([
  ['looker', withMcp(['github', 'jira?'])],
  ['poster', withMcp(['github?', 'slack'])],
  ['deep-agent', withMcp(['docs'])],
]);

function parse(source: string) {
  const parsed = parseWorkflowDefinition(source, 'global');
  if (!parsed.ok) {
    throw new Error(parsed.error.issues.join('; '));
  }
  return parsed.value;
}

describe('requiredMcpServers (derived from the agents, sub-workflows and lanes included)', () => {
  it('collects every server the agents name, required winning over optional', () => {
    const inner = parse(INNER);
    const found = requiredMcpServers(
      parse(SOURCE),
      (name) => agents.get(name),
      (name) => (name === 'inner' ? inner : undefined),
    );
    expect(found.map((entry) => [entry.name, entry.optional, entry.agents])).toEqual([
      ['github', false, ['looker', 'poster']], // looker needs it, poster only wants it → required
      ['jira', true, ['looker']],
      ['docs', false, ['deep-agent']],
      ['slack', false, ['poster']],
    ]);
    expect(parseMcpName('jira?')).toEqual({ name: 'jira', optional: true });
    expect(
      describeMissingMcpServers(
        'needs-mcp',
        found.filter((e) => e.name === 'slack'),
      ),
    ).toContain("needs-mcp needs the MCP server 'slack' (agent poster)");
  });

  it('lints a warning per unconfigured required server - none without the machine list', () => {
    const workflow = parse(SOURCE);
    const ctx = {
      agentNames: ['looker', 'poster', 'deep-agent'],
      workflowNames: ['inner'],
      agentMcp: new Map([...agents.entries()].map(([name, agent]) => [name, agent.tools.mcp])),
    };
    const without = lintWorkflow(workflow, ctx);
    expect(without.problems.filter((p) => p.code === 'mcp/unconfigured')).toHaveLength(0);
    const withList = lintWorkflow(workflow, { ...ctx, mcpServers: ['github'] });
    const warnings = withList.problems.filter((p) => p.code === 'mcp/unconfigured');
    expect(warnings.map((p) => p.message)).toEqual([
      "agent 'poster' uses MCP server 'slack', which was not offered to this run - offer it, or mark it optional (slack?)",
    ]);
    expect(withList.ok).toBe(true); // a warning, not an error
  });
});
