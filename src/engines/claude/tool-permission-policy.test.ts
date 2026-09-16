import { describe, expect, it } from 'vitest';
import { commandSegments, decideToolPermission } from './tool-permission-policy';

const policy = {
  cwd: '/work/task-1',
  allowWrite: true,
  commandAllowlist: ['npm test', 'git status'],
};

describe('decideToolPermission', () => {
  it('allows read-style tools unconditionally', () => {
    expect(decideToolPermission('Read', {}, policy).allow).toBe(true);
    expect(decideToolPermission('Grep', {}, policy).allow).toBe(true);
  });

  it('denies network tools', () => {
    const decision = decideToolPermission('WebFetch', { url: 'https://x' }, policy);
    expect(decision.allow).toBe(false);
    expect(decision.reason).toContain('network');
  });

  it('denies ad-hoc sub-agent tools', () => {
    const decision = decideToolPermission('Task', { prompt: 'go explore' }, policy);
    expect(decision.allow).toBe(false);
    expect(decision.reason).toContain('orchestrated by workflows');
  });

  it('allows writes inside the workspace, denies outside', () => {
    expect(
      decideToolPermission('Write', { file_path: '/work/task-1/src/a.ts' }, policy).allow,
    ).toBe(true);
    expect(decideToolPermission('Edit', { file_path: 'relative/b.ts' }, policy).allow).toBe(true);
    const outside = decideToolPermission('Write', { file_path: '/etc/passwd' }, policy);
    expect(outside.allow).toBe(false);
    expect(outside.reason).toContain('task workspace');
    const traversal = decideToolPermission(
      'Write',
      { file_path: '/work/task-1/../task-2/a.ts' },
      policy,
    );
    expect(traversal.allow).toBe(false);
  });

  it('denies all writes when write access is off', () => {
    const readOnly = { ...policy, allowWrite: false };
    const decision = decideToolPermission('Write', { file_path: '/work/task-1/a.ts' }, readOnly);
    expect(decision.allow).toBe(false);
    expect(decision.reason).toContain('write access is disabled');
  });

  it('allows only allowlisted command prefixes', () => {
    expect(decideToolPermission('Bash', { command: 'npm test' }, policy).allow).toBe(true);
    expect(decideToolPermission('Bash', { command: 'npm test -- --coverage' }, policy).allow).toBe(
      true,
    );
    expect(decideToolPermission('Bash', { command: 'npm testx' }, policy).allow).toBe(false);
    expect(decideToolPermission('Bash', { command: 'rm -rf /' }, policy).allow).toBe(false);
  });

  it('denies every command when the allowlist is empty', () => {
    const locked = { ...policy, commandAllowlist: [] };
    const decision = decideToolPermission('Bash', { command: 'git status' }, locked);
    expect(decision.allow).toBe(false);
    expect(decision.reason).toContain('no commands are allowlisted');
  });
});

describe('MCP tools', () => {
  const policy = {
    cwd: '/work',
    allowWrite: false,
    commandAllowlist: [],
    mcpServers: [{ name: 'github-mcp', kind: 'stdio' as const, command: 'npx' }],
  };

  it('allows tools from servers the agent enabled', () => {
    expect(decideToolPermission('mcp__github-mcp__list_issues', {}, policy).allow).toBe(true);
  });

  it('denies tools from servers the agent did not enable', () => {
    const decision = decideToolPermission('mcp__other__anything', {}, policy);
    expect(decision.allow).toBe(false);
    expect(decision.reason).toContain("'other'");
  });

  it('denies all MCP tools when the agent has none enabled', () => {
    const bare = { cwd: '/work', allowWrite: false, commandAllowlist: [] };
    expect(decideToolPermission('mcp__github-mcp__list_issues', {}, bare).allow).toBe(false);
  });
});

describe('network permission', () => {
  const base = { cwd: '/work', allowWrite: false, commandAllowlist: [] };

  it('denies WebSearch/WebFetch by default', () => {
    expect(decideToolPermission('WebSearch', {}, base).allow).toBe(false);
    expect(decideToolPermission('WebFetch', {}, base).allow).toBe(false);
  });

  it("honors the agent's network knob", () => {
    const allowed = { ...base, allowNetwork: true };
    expect(decideToolPermission('WebSearch', {}, allowed).allow).toBe(true);
    expect(decideToolPermission('WebFetch', {}, allowed).allow).toBe(true);
  });
});

describe('escalatable denials', () => {
  const policy = {
    cwd: '/tmp/w',
    allowWrite: true,
    allowNetwork: false,
    commandAllowlist: ['git status'],
    mcpServers: [],
  };

  it('marks off-allowlist commands as escalatable with the command as detail', () => {
    const decision = decideToolPermission('Bash', { command: 'pnpm test' }, policy);
    expect(decision.allow).toBe(false);
    expect(decision.escalatable).toBe(true);
    expect(decision.detail).toBe('pnpm test');
  });

  it('marks denied network tools as escalatable', () => {
    const decision = decideToolPermission('WebFetch', { url: 'https://x.dev' }, policy);
    expect(decision.allow).toBe(false);
    expect(decision.escalatable).toBe(true);
    expect(decision.detail).toContain('https://x.dev');
  });

  it('never escalates workspace escapes or sub-agents', () => {
    const write = decideToolPermission('Write', { file_path: '/etc/passwd' }, policy);
    expect(write.allow).toBe(false);
    expect(write.escalatable).toBeUndefined();
    const task = decideToolPermission('Task', {}, policy);
    expect(task.escalatable).toBeUndefined();
  });
});

describe('compound commands', () => {
  const policy = {
    cwd: '/w',
    allowWrite: false,
    allowNetwork: false,
    commandAllowlist: ['git show', 'git log', 'gh pr view'],
    mcpServers: [],
  };
  const decide = (command: string) => decideToolPermission('Bash', { command }, policy);

  it('splits on separators, pipes and newlines, lifting substitutions out', () => {
    expect(commandSegments('cd /w\necho "=== a ===" ; git show --stat abc | tail -20')).toEqual([
      'cd /w',
      'echo "=== a ==="',
      'git show --stat abc',
      'tail -20',
    ]);
    expect(commandSegments('echo "sha: $(git rev-parse HEAD)" && git log -1')).toEqual([
      'git rev-parse HEAD',
      'echo "sha: "',
      'git log -1',
    ]);
  });

  it('allows a line whose every piece is allowlisted or a free shell word', () => {
    expect(
      decide('cd /w/pr-review\necho "=== squash ==="; git show --stat --oneline 86e9 | head -40')
        .allow,
    ).toBe(true);
    expect(decide('gh pr view 9124 --comments 2>&1 | tail -80').allow).toBe(true);
    expect(decide('for c in a b; do git show --stat $c; done').allow).toBe(true);
    expect(decide('FOO=1 git log -1 --format=%B abc').allow).toBe(true);
  });

  it('blocks the line when one piece is off the list, naming it and the allowlist', () => {
    const decision = decide('cd /w; git fetch origin -q; git show HEAD');
    expect(decision.allow).toBe(false);
    expect(decision.escalatable).toBe(true);
    expect(decision.reason).toContain("not in this agent's allowlist: git fetch origin -q");
    expect(decision.reason).toContain('allowed: git show, git log, gh pr view');
    expect(decide('echo "$(curl https://x)"').allow).toBe(false);
  });
});
