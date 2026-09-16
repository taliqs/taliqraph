import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EXIT } from '../exit-codes';
import { mockAgent, ONE_STEP_WORKFLOW, scratchContext, writeTree } from '../test-helpers';
import { lintCommand } from './lint';

const BROKEN_WORKFLOW = [
  'name: broken',
  'title: Broken',
  'steps:',
  '  - id: work',
  '    agent: nobody',
  '    input: []',
  '',
].join('\n');

afterEach(() => {
  process.exitCode = undefined;
});

describe('lint', () => {
  it('lints a package folder given as a path and passes a sound one', async () => {
    const context = await scratchContext();
    const pkg = join(context.cwd, 'pkg');
    await writeTree(pkg, {
      'workflow.yaml': ONE_STEP_WORKFLOW,
      'agents/worker.agent.md': mockAgent('worker'),
    });
    await lintCommand(context, pkg, {});
    expect(context.lines[0]).toBe('one-step: ok');
    expect(process.exitCode).toBe(EXIT.ok);
  });

  it('reports the errors of a package and exits 2', async () => {
    const context = await scratchContext();
    await writeTree(join(context.cwd, 'broken'), { 'workflow.yaml': BROKEN_WORKFLOW });
    await lintCommand(context, 'broken', {});
    expect(context.lines[0]).toMatch(/^broken: 1 error/);
    expect(context.lines.some((line) => line.includes('nobody'))).toBe(true);
    expect(process.exitCode).toBe(EXIT.problems);
  });

  it('lints the current folder when it is a package, and refuses one that is not', async () => {
    const context = await scratchContext();
    await expect(lintCommand(context, undefined, {})).rejects.toThrow(/not a workflow package/);
    await writeTree(context.cwd, {
      'workflow.yaml': ONE_STEP_WORKFLOW,
      'agents/worker.agent.md': mockAgent('worker'),
    });
    await lintCommand(context, undefined, {});
    expect(context.lines[0]).toBe('one-step: ok');
    await expect(lintCommand(context, 'missing', {})).rejects.toThrow(/does not exist/);
  });

  it('takes the MCP servers the run would offer, so a satisfied requirement is not an error', async () => {
    const context = await scratchContext();
    const pkg = join(context.cwd, 'pkg');
    await writeTree(pkg, {
      'workflow.yaml': ONE_STEP_WORKFLOW,
      'agents/worker.agent.md': mockAgent('worker').replace(
        '---\nYou are worker.',
        'tools:\n  mcp: [docs]\n---\nYou are worker.',
      ),
    });
    await writeTree(context.cwd, {
      'mcp.json': JSON.stringify([{ name: 'docs', kind: 'stdio', command: 'echo' }]),
    });
    await lintCommand(context, pkg, {});
    expect(context.lines[0]).toMatch(/^one-step: 1 error/);
    expect(process.exitCode).toBe(EXIT.problems);

    context.lines.length = 0;
    await lintCommand(context, pkg, { mcpServers: join(context.cwd, 'mcp.json') });
    expect(context.lines[0]).toBe('one-step: ok');
    expect(process.exitCode).toBe(EXIT.ok);
  });
});
