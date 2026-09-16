import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ScriptDefinition } from '../definitions/script/script-definition';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runWorkflowScript, tokenize } from './run-workflow-script';

let dir: string;
let workspace: string;

const definition = (run: string, extra: Partial<ScriptDefinition> = {}): ScriptDefinition => ({
  name: 'probe',
  description: 'test probe',
  run,
  inputs: [],
  timeoutMinutes: 1,
  scope: 'global',
  dir,
  ...extra,
});

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tq-script-def-'));
  workspace = await mkdtemp(join(tmpdir(), 'tq-script-ws-'));
  // logs a line, then ends with the report as its last JSON line
  await writeFile(
    join(dir, 'run.mjs'),
    [
      "import { readFileSync } from 'node:fs';",
      'const inputs = JSON.parse(readFileSync(process.env.TQ_INPUTS, "utf8"));',
      'console.log("working in " + process.env.TQ_WORKSPACE);',
      'console.log(JSON.stringify({ got: inputs.task, count: inputs.list.length, viaEnv: JSON.parse(process.env.TQ_INPUT_LIST).length, raw: process.env.TQ_INPUT_TASK, dir: process.env.TQ_SCRIPT_DIR, cwd: process.cwd() }));',
    ].join('\n'),
  );
  // writes the report file - that wins over whatever stdout says
  await writeFile(
    join(dir, 'file.mjs'),
    [
      "import { writeFileSync } from 'node:fs';",
      "let stdin = ''; process.stdin.on('data', (c) => (stdin += c)); process.stdin.on('end', () => {",
      '  writeFileSync(process.env.TQ_REPORT_FILE, JSON.stringify({ fromFile: true, stdinKeys: Object.keys(JSON.parse(stdin)) }));',
      '  console.log("{\\"ignored\\": true}");',
      '});',
    ].join('\n'),
  );
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(workspace, { recursive: true, force: true });
});

describe('runWorkflowScript', () => {
  it('runs a definition without a shell: relative files resolve against its folder, cwd is the workspace, inputs arrive three ways', async () => {
    const result = await runWorkflowScript(
      {
        definition: definition('node run.mjs'),
        inputs: { task: 'Fix sum', list: [1, 2, 3] },
        timeoutMs: 30_000,
      },
      workspace,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('working in');
    const lastLine = result.stdout.trim().split('\n').at(-1) ?? '';
    expect(JSON.parse(lastLine)).toMatchObject({
      got: 'Fix sum',
      count: 3,
      viaEnv: 3,
      raw: 'Fix sum',
      dir,
    });
    expect(result.report).toBeUndefined(); // nothing written to TQ_REPORT_FILE
  });

  it('prefers the report file when the script writes one, and feeds the inputs JSON on stdin', async () => {
    const result = await runWorkflowScript(
      {
        definition: definition('node file.mjs'),
        inputs: { task: 'x', plan: { steps: [] } },
        timeoutMs: 30_000,
      },
      workspace,
    );
    expect(result.exitCode).toBe(0);
    expect(result.report).toEqual({ fromFile: true, stdinKeys: ['task', 'plan'] });
  });

  it('reports a missing executable and a failing exit code without throwing', async () => {
    const missing = await runWorkflowScript(
      { definition: definition('definitely-not-a-program-cb --x'), inputs: {}, timeoutMs: 30_000 },
      workspace,
    );
    expect(missing.exitCode).not.toBe(0);
    expect(missing.stderr).toContain('definitely-not-a-program-cb');
    const failing = await runWorkflowScript(
      { definition: definition('node -e process.exit(3)'), inputs: {}, timeoutMs: 30_000 },
      workspace,
    );
    expect(failing.exitCode).toBe(3);
  });

  it('runs an inline command through the shell with the same environment; positional args become TQ_ARG_<n>', async () => {
    const result = await runWorkflowScript(
      {
        command:
          'node -e "console.log(JSON.stringify({ws: process.env.TQ_WORKSPACE, t: process.env.TQ_INPUT_TASK, a1: process.env.TQ_ARG_1, a2: process.env.TQ_ARG_2, none: process.env.TQ_INPUT_ARGS}))"',
        inputs: { task: 'hi', args: ['first', { n: 2 }] },
        timeoutMs: 30_000,
      },
      workspace,
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({
      ws: workspace,
      t: 'hi',
      a1: 'first',
      a2: '{"n":2}',
    });
  });
});

it('a spec env REPLACES the host environment - only it plus the TQ_* contract reaches the script', async () => {
  process.env['TQ_TEST_HOST_ONLY'] = 'leaks-if-inherited';
  try {
    const result = await runWorkflowScript(
      {
        command:
          'node -e "console.log(JSON.stringify({host: process.env.TQ_TEST_HOST_ONLY, mine: process.env.GH_TOKEN, ws: process.env.TQ_WORKSPACE, path: typeof process.env.PATH}))"',
        inputs: { task: 'hi', args: [] },
        timeoutMs: 30_000,
        env: { PATH: process.env['PATH'] ?? '', GH_TOKEN: 'from-the-step' },
      },
      workspace,
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({
      mine: 'from-the-step',
      ws: workspace,
      path: 'string',
    });
  } finally {
    delete process.env['TQ_TEST_HOST_ONLY'];
  }
});

describe('tokenize', () => {
  it('splits on whitespace and honours quotes', () => {
    expect(tokenize('node run.mjs --reporter json')).toEqual([
      'node',
      'run.mjs',
      '--reporter',
      'json',
    ]);
    expect(tokenize(`python3 "my script.py" --name 'a b'  c`)).toEqual([
      'python3',
      'my script.py',
      '--name',
      'a b',
      'c',
    ]);
    expect(tokenize('')).toEqual([]);
  });
});
