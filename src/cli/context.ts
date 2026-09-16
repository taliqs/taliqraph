import { resolve } from 'node:path';
import { EXIT } from './exit-codes';
import { Output } from './output';

/** Options every command inherits from the program. */
export interface GlobalOptions {
  readonly cwd?: string;
  /** `--mcp-servers <file>`: the servers a run may offer and a lint checks against. */
  readonly mcpServers?: string;
  readonly json?: boolean;
  readonly color?: boolean;
  readonly quiet?: boolean;
}

/** What a command works with: the working folder and the output. */
export interface CliContext {
  readonly cwd: string;
  readonly out: Output;
}

export function openCli(globals: GlobalOptions): CliContext {
  const cwd = resolve(globals.cwd ?? process.cwd());
  const out = new Output({
    json: globals.json ?? false,
    quiet: globals.quiet ?? false,
    color: (globals.color ?? true) && process.stdout.isTTY === true && !process.env['NO_COLOR'],
  });
  return { cwd, out };
}

/** Runs one command; a thrown error becomes a one-line message and exit code 1 (commands set other codes themselves). */
export async function withCli(
  globals: GlobalOptions,
  run: (context: CliContext) => Promise<void>,
): Promise<void> {
  const context = openCli(globals);
  try {
    await run(context);
  } catch (cause) {
    context.out.error(cause instanceof Error ? cause.message : String(cause));
    process.exitCode = EXIT.error;
  }
}
