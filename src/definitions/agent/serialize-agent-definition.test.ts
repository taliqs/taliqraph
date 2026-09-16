import { describe, expect, it } from 'vitest';
import type { AgentDefinition } from './agent-definition';
import { parseAgentDefinition } from './parse-agent-definition';
import { serializeAgentDefinition } from './serialize-agent-definition';

const richAgent: AgentDefinition = {
  name: 'investigator',
  description: 'Read-only detective: traces bugs before anyone edits.',
  engine: 'claude-code',
  model: 'sonnet-5',
  effort: 'med',
  tools: {
    read: 'always',
    write: 'off',
    commands: 'allowlist',
    commandAllowlist: ['git log', 'npm test'],
    network: 'off',
    mcp: [],
  },
  outputSchema: 'findings-report',
  scope: 'global',
  prompt: 'You investigate - you never edit files.\n\n- Find the root cause.',
  reportExample: '{\n  "summary": "one paragraph",\n  "rootCause": "file:line"\n}',
};

const minimalAgent: AgentDefinition = {
  name: 'helper',
  description: 'Small helper.',
  engine: 'claude-code',
  model: 'haiku',
  effort: 'low',
  tools: {
    read: 'always',
    write: 'workspace',
    commands: 'off',
    commandAllowlist: [],
    network: 'off',
    mcp: [],
  },
  scope: 'global',
  prompt: 'Help briefly.',
};

describe('serializeAgentDefinition', () => {
  it('roundtrips a rich definition through the parser unchanged', () => {
    const parsed = parseAgentDefinition(serializeAgentDefinition(richAgent), 'global');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value).toEqual(richAgent);
    }
  });

  it('roundtrips a minimal definition and omits empty optional fields', () => {
    const source = serializeAgentDefinition(minimalAgent);
    expect(source).not.toContain('match:');
    expect(source).not.toContain('output_schema:');
    expect(source).not.toContain('allowlist:');
    expect(source).not.toContain('## Report');
    const parsed = parseAgentDefinition(source, 'global');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value).toEqual(minimalAgent);
    }
  });

  it('keeps prompt and report contract separate through the roundtrip', () => {
    const source = serializeAgentDefinition(richAgent);
    expect(source).toContain('## Report');
    const parsed = parseAgentDefinition(source, 'global');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.prompt).not.toContain('## Report');
      expect(parsed.value.prompt).not.toContain('summary');
      expect(parsed.value.reportExample).toContain('"rootCause"');
    }
  });
});

it('round-trips an mcp server allowlist through frontmatter', () => {
  const source = serializeAgentDefinition({
    name: 'researcher',
    description: 'Explores with MCP tools.',
    engine: 'claude-code',
    model: 'sonnet-5',
    effort: 'med',
    tools: {
      read: 'always',
      write: 'off',
      commands: 'off',
      commandAllowlist: [],
      network: 'off',
      mcp: ['github-mcp', 'docs'],
    },
    scope: 'global',
    prompt: 'You research.',
  });
  expect(source).toContain('mcp:');
  const parsed = parseAgentDefinition(source, 'global');
  if (!parsed.ok) {
    throw new Error(parsed.error.message);
  }
  expect(parsed.value.tools.mcp).toEqual(['github-mcp', 'docs']);
});
