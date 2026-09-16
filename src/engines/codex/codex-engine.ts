import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { engineAuthEnvironment } from '../engine-environment';
import type {
  EngineAdapter,
  EngineAuthStatus,
  EngineCapabilities,
  EngineRunSpec,
  EngineSession,
} from '../engine-adapter';
import type { EngineEvent } from '../engine-event';
import { AsyncQueue } from '../utils/async-queue';
import { parseTrailingJsonReport } from '../claude/parse-trailing-json-report';
import { errorEventOf } from '../quota-error';
import { translateCodexLine, type CodexTranslationState } from './translate-codex-line';

/**
 * Runs `codex exec --json` and streams the JSONL back; injectable so the
 * adapter is fully testable without the binary.
 */
export type CodexSpawnFn = (
  args: readonly string[],
  options: { cwd: string; signal: AbortSignal; env?: Readonly<Record<string, string>> },
  onLine: (line: string) => void,
) => Promise<{ exitCode: number | null }>;

const defaultSpawn: CodexSpawnFn = (args, options, onLine) =>
  new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('codex', [...args], {
      cwd: options.cwd,
      signal: options.signal,
      // a clean environment plus the engine's own auth; else the host's
      env: options.env ? { ...options.env, ...engineAuthEnvironment() } : process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        onLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
      }
    });
    let stderrTail = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderrTail = `${stderrTail}${chunk}`.slice(-2000);
    });
    child.on('error', rejectPromise);
    child.on('close', (code) => {
      if (buffer.trim().length > 0) {
        onLine(buffer);
      }
      if (code !== 0 && code !== null) {
        rejectPromise(new Error(stderrTail.trim() || `codex exited with code ${code}`));
        return;
      }
      resolvePromise({ exitCode: code });
    });
  });

export const CODEX_MODELS = [
  { id: 'gpt-5-codex', label: 'GPT-5 Codex' },
  { id: 'gpt-5', label: 'GPT-5' },
] as const;

export interface CodexEngineOptions {
  readonly spawnFn?: CodexSpawnFn;
  readonly authFilePath?: string;
  readonly binaryProbe?: () => boolean;
}

/**
 * OpenAI's codex CLI as an engine. Capability gaps are declared, not papered
 * over: no per-command permission callbacks (the OS sandbox carries write
 * policy), no MCP wiring, no mid-run chat injection.
 */
export class CodexEngine implements EngineAdapter {
  readonly id = 'codex';
  readonly label = 'Codex';
  private readonly spawnFn: CodexSpawnFn;
  private readonly authFilePath: string;
  private readonly binaryProbe: () => boolean;

  constructor(options: CodexEngineOptions = {}) {
    this.spawnFn = options.spawnFn ?? defaultSpawn;
    this.authFilePath = options.authFilePath ?? join(homedir(), '.codex', 'auth.json');
    this.binaryProbe =
      options.binaryProbe ??
      (() => (process.env['PATH'] ?? '').split(':').some((dir) => existsSync(join(dir, 'codex'))));
  }

  capabilities(): EngineCapabilities {
    return {
      models: [...CODEX_MODELS],
      effort: true,
      mcp: false,
      permissionCallbacks: false,
      resume: false,
    };
  }

  authStatus(): Promise<EngineAuthStatus> {
    if (!this.binaryProbe()) {
      return Promise.resolve({ state: 'not-installed' });
    }
    return Promise.resolve(
      existsSync(this.authFilePath) ? { state: 'authenticated' } : { state: 'unauthenticated' },
    );
  }

  startSession(spec: EngineRunSpec): EngineSession {
    return new CodexSession(spec, this.spawnFn);
  }
}

class CodexSession implements EngineSession {
  readonly id = randomUUID();
  private readonly abort = new AbortController();
  private readonly queue = new AsyncQueue<EngineEvent>();
  private started = false;

  constructor(
    private readonly spec: EngineRunSpec,
    private readonly spawnFn: CodexSpawnFn,
  ) {}

  async *events(): AsyncIterable<EngineEvent> {
    if (this.started) {
      throw new Error('Codex sessions run once');
    }
    this.started = true;
    const state: CodexTranslationState = { lastAgentMessage: '', model: this.spec.model };
    void this.spawnFn(
      buildExecArgs(this.spec),
      {
        cwd: this.spec.cwd,
        signal: this.abort.signal,
        ...(this.spec.env ? { env: this.spec.env } : {}),
      },
      (line) => {
        for (const event of translateCodexLine(line, state)) {
          this.queue.push(event);
        }
      },
    )
      .then(() => {
        // codex exec has no explicit final event on some versions - synthesize
        // done from the last agent message (the report rides its tail).
        if (!state.done) {
          const report = parseTrailingJsonReport(state.lastAgentMessage);
          this.queue.push({ type: 'done', ...(report !== undefined ? { report } : {}) });
        }
      })
      .catch((cause: unknown) => {
        if (!this.abort.signal.aborted) {
          this.queue.push(errorEventOf(cause instanceof Error ? cause.message : String(cause)));
        }
      })
      .finally(() => {
        this.queue.close();
      });

    yield* this.queue;
  }

  /** codex exec is one-shot - mid-run chat cannot reach it (declared capability gap). */
  send(): void {
    // Queued user notes still reach the NEXT step via the orchestrator.
  }

  cancel(): void {
    this.abort.abort();
    this.queue.close();
  }
}

const EFFORT_TO_CODEX: Record<string, string> = { low: 'low', med: 'medium', high: 'high' };

export function buildExecArgs(spec: EngineRunSpec): string[] {
  const args = [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '-C',
    spec.cwd,
    '-m',
    spec.model,
    '--sandbox',
    spec.allowWrite ? 'workspace-write' : 'read-only',
  ];
  if (spec.effort && EFFORT_TO_CODEX[spec.effort]) {
    args.push('-c', `model_reasoning_effort="${EFFORT_TO_CODEX[spec.effort]}"`);
  }
  // codex exec has no separate system-prompt channel - it rides ahead of the task.
  args.push(`${spec.systemPrompt}\n\n---\n\n${spec.userMessage}`);
  return args;
}
