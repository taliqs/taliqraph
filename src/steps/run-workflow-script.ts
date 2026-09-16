import type { ChildProcess } from 'node:child_process';
import { exec, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { ScriptDefinition } from '../definitions/script/script-definition';
import type { ScriptResult, ScriptRunSpec } from '../orchestrator/workflow-run';

const OUTPUT_CAP_BYTES = 1024 * 1024;

/**
 * Executes one workflow script step inside the workspace. Scripts are
 * user-authored content: full access, cwd pinned, hard timeout, capped output.
 *
 * The contract, for definitions and inline commands alike:
 *   - inputs three ways: the JSON file at `$TQ_INPUTS` ({ inputs, args: [...in the
 *     step's order], <parameter>: value }), the same JSON on stdin, and environment
 *     variables - `TQ_ARG_<n>` positional, `TQ_INPUT_<NAME>` by name (strings raw, else JSON)
 *   - `TQ_WORKSPACE` (the workspace), `TQ_SCRIPT_DIR` (a definition's folder),
 *     `TQ_REPORT_FILE` (write the report there instead of printing it)
 * A definition's `run` is spawned WITHOUT a shell (no quoting or `$VAR` syntax
 * differences between PowerShell and sh), its relative paths resolved against
 * its folder; an inline command runs through the shell.
 */
export async function runWorkflowScript(spec: ScriptRunSpec, cwd: string): Promise<ScriptResult> {
  const scratch = await mkdtemp(join(tmpdir(), `taliqraph-script-`));
  const inputsPath = join(scratch, 'inputs.json');
  const reportPath = join(scratch, 'report.json');
  const inputsJson = JSON.stringify(spec.inputs, null, 2);
  await writeFile(inputsPath, inputsJson);
  const env: NodeJS.ProcessEnv = {
    // a clean environment when the run built one; the host's otherwise
    ...(spec.env ?? process.env),
    TQ_WORKSPACE: cwd,
    TQ_INPUTS: inputsPath,
    TQ_REPORT_FILE: reportPath,
    ...(spec.definition?.dir ? { TQ_SCRIPT_DIR: spec.definition.dir } : {}),
    ...inputEnv(spec.inputs),
  };
  try {
    const raw = spec.definition
      ? await runDefinition(spec.definition, cwd, env, inputsJson, spec.timeoutMs)
      : await runInline(spec.command ?? '', cwd, env, inputsJson, spec.timeoutMs);
    const report = await readReport(reportPath);
    return report === undefined ? raw : { ...raw, report };
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * `TQ_ARG_1`, `TQ_ARG_2`… for the positional `args`; `TQ_INPUT_<NAME>` for every
 * other key - `TQ_INPUT_IMPLEMENTATION` for `implementation`, `TQ_INPUT_REVIEW_BUG_HUNT`
 * for `review.bug-hunt`. Strings raw, everything else JSON.
 */
function inputEnv(inputs: Readonly<Record<string, unknown>>): Record<string, string> {
  const asEnv = (value: unknown): string =>
    typeof value === 'string' ? value : JSON.stringify(value);
  const entries: [string, string][] = [];
  for (const [name, value] of Object.entries(inputs)) {
    if (name === 'args' && Array.isArray(value)) {
      value.forEach((item, index) => entries.push([`TQ_ARG_${index + 1}`, asEnv(item)]));
      continue;
    }
    entries.push([`TQ_INPUT_${name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`, asEnv(value)]);
  }
  return Object.fromEntries(entries);
}

async function readReport(reportPath: string): Promise<unknown> {
  try {
    const text = await readFile(reportPath, 'utf8');
    return text.trim().length > 0 ? (JSON.parse(text) as unknown) : undefined;
  } catch {
    return undefined; // not written, or not JSON - stdout decides
  }
}

function runInline(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  stdin: string,
  timeoutMs: number,
): Promise<ScriptResult> {
  return new Promise((resolveResult) => {
    const child = exec(
      command,
      { cwd, timeout: timeoutMs, maxBuffer: OUTPUT_CAP_BYTES, env },
      (error, stdout, stderr) => {
        const exitCode = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
        resolveResult({
          exitCode,
          stdout: String(stdout),
          stderr:
            error && error.killed ? `${String(stderr)}\n${timedOut(timeoutMs)}` : String(stderr),
        });
      },
    );
    feedStdin(child, stdin);
  });
}

async function runDefinition(
  definition: ScriptDefinition,
  cwd: string,
  env: NodeJS.ProcessEnv,
  stdin: string,
  timeoutMs: number,
): Promise<ScriptResult> {
  const argv = await resolveArgv(tokenize(definition.run), definition.dir);
  const [executable, ...args] = argv;
  if (!executable) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: `script '${definition.name}' has an empty run command`,
    };
  }
  const attempt = (shell: boolean): Promise<ScriptResult | 'not-found'> =>
    new Promise((resolveResult) => {
      const child = spawn(executable, args, { cwd, env, shell, windowsHide: true });
      let stdout = '';
      let stderr = '';
      let killed = false;
      const timer = setTimeout(() => {
        killed = true;
        child.kill();
      }, timeoutMs);
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout = cap(stdout + chunk.toString());
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr = cap(stderr + chunk.toString());
      });
      child.on('error', (error: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        if (error.code === 'ENOENT' && !shell) {
          resolveResult('not-found');
          return;
        }
        resolveResult({ exitCode: 1, stdout, stderr: `${stderr}\n${error.message}`.trim() });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolveResult({
          exitCode: code ?? (killed ? 124 : 1),
          stdout,
          stderr: killed ? `${stderr}\n${timedOut(timeoutMs)}` : stderr,
        });
      });
      feedStdin(child, stdin);
    });
  const direct = await attempt(false);
  if (direct !== 'not-found') {
    return direct;
  }
  // `pnpm`, `npx` and friends are .cmd shims on Windows - only a shell can start those
  const viaShell = await attempt(true);
  return viaShell === 'not-found'
    ? { exitCode: 127, stdout: '', stderr: `'${executable}' was not found on PATH` }
    : viaShell;
}

function feedStdin(child: ChildProcess, stdin: string): void {
  if (!child.stdin) {
    return;
  }
  child.stdin.on('error', () => undefined); // a script that never reads stdin closes it - not an error
  child.stdin.end(stdin);
}

/** Tokens of a run line - whitespace-separated, single or double quotes group. */
export function tokenize(run: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: string | null = null;
  let has = false;
  for (const char of run) {
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
    } else if (char === '"' || char === "'") {
      quote = char;
      has = true;
    } else if (/\s/.test(char)) {
      if (has || current.length > 0) {
        tokens.push(current);
        current = '';
        has = false;
      }
    } else {
      current += char;
    }
  }
  if (has || current.length > 0) {
    tokens.push(current);
  }
  return tokens;
}

/** A relative token that names a file inside the script's folder becomes absolute - the child runs with cwd = workspace. */
async function resolveArgv(tokens: readonly string[], dir: string | undefined): Promise<string[]> {
  if (!dir) {
    return [...tokens];
  }
  return Promise.all(
    tokens.map(async (token) => {
      if (isAbsolute(token) || token.startsWith('-') || !/[./\\]|^[\w.-]+\.\w+$/.test(token)) {
        return token;
      }
      const candidate = resolve(dir, token);
      try {
        await stat(candidate);
        return candidate;
      } catch {
        return token;
      }
    }),
  );
}

function cap(text: string): string {
  return text.length <= OUTPUT_CAP_BYTES ? text : text.slice(-OUTPUT_CAP_BYTES);
}

function timedOut(timeoutMs: number): string {
  return `(timed out after ${Math.round(timeoutMs / 60_000)} minutes)`;
}
