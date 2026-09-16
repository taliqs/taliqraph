import { describe, expect, it } from 'vitest';
import { parseAgentDefinition } from './parse-agent-definition';

const validAgent = `---
name: software-engineer
description: Implements planned changes.
engine: anthropic
model: sonnet-5
effort: high
tools:
  read: always
  write: workspace
  commands: allowlist
  allowlist: [npm test, npm run build]
  network: off
  github: read
  jira: off
---
You are the implementing engineer.
Keep every change sized for one reviewable PR.
`;

describe('parseAgentDefinition', () => {
  it('parses a full agent definition', () => {
    const result = parseAgentDefinition(validAgent, 'global');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.name).toBe('software-engineer');
    expect(result.value.effort).toBe('high');
    expect(result.value.scope).toBe('global');
    expect(result.value.prompt).toContain('implementing engineer');
    expect(result.value.tools.commandAllowlist).toEqual(['npm test', 'npm run build']);
  });

  it('applies defaults for omitted optional fields', () => {
    const minimal = `---
name: investigator
description: Read-only detective.
engine: anthropic
model: sonnet-5
---
You investigate. You never edit.
`;
    const result = parseAgentDefinition(minimal, 'project');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.effort).toBe('med');
    expect(result.value.tools).toEqual({
      read: 'always',
      write: 'workspace',
      commands: 'allowlist',
      commandAllowlist: [],
      network: 'off',
      mcp: [],
    });
  });

  it('ignores a frontmatter key it does not know, rather than rejecting the file', () => {
    const withUnknownKeys = `---
name: investigator
description: Read-only detective.
engine: anthropic
model: sonnet-5
output_schema: findings-report
match: [investigate, trace]
some_future_key: whatever
---
You investigate. You never edit.
`;
    const result = parseAgentDefinition(withUnknownKeys, 'project');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(Object.keys(result.value).sort()).toEqual([
      'description',
      'effort',
      'engine',
      'model',
      'name',
      'prompt',
      'scope',
      'tools',
    ]);
  });

  it('rejects a file without frontmatter', () => {
    const result = parseAgentDefinition('Just a prompt.', 'global');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('frontmatter');
  });

  it('rejects invalid field values with pointed issues', () => {
    const invalid = validAgent.replace('effort: high', 'effort: extreme');
    const result = parseAgentDefinition(invalid, 'global');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.issues.some((issue) => issue.startsWith('effort'))).toBe(true);
  });

  it('rejects an empty prompt body', () => {
    const noBody = validAgent.slice(0, validAgent.indexOf('You are'));
    const result = parseAgentDefinition(noBody, 'global');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('prompt body is empty');
  });

  it('splits a ## Report section into reportExample, keeping the prompt clean', () => {
    const parsed = parseAgentDefinition(
      `---\nname: a\ndescription: d\nengine: e\nmodel: m\n---\nDo the work.\n\n## Report\n\n\`\`\`json\n{ "summary": "..." }\n\`\`\`\n`,
      'global',
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.prompt).toBe('Do the work.');
      expect(parsed.value.reportExample).toBe('{ "summary": "..." }');
    }
  });

  it('rejects a ## Report section without a fenced json block', () => {
    const parsed = parseAgentDefinition(
      `---\nname: a\ndescription: d\nengine: e\nmodel: m\n---\nDo the work.\n\n## Report\n\njust text\n`,
      'global',
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.message).toContain('fenced');
    }
  });

  it('rejects a ## Report example that is not valid JSON', () => {
    const parsed = parseAgentDefinition(
      `---\nname: a\ndescription: d\nengine: e\nmodel: m\n---\nDo the work.\n\n## Report\n\n\`\`\`json\n{ broken\n\`\`\`\n`,
      'global',
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.message).toContain('not valid JSON');
    }
  });
});
