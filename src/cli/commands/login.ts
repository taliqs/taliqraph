import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Command } from 'commander';
import type { GlobalOptions } from '../context';
import { withCli } from '../context';
import { EXIT } from '../exit-codes';

interface LoginCommand {
  readonly command: string;
  readonly args: readonly string[];
}

/** The engine's own login flow, in this terminal. */
function loginCommandFor(engineId: string): LoginCommand {
  switch (engineId) {
    case 'claude':
    case 'anthropic':
      return { command: 'claude', args: ['/login'] };
    default:
      throw new Error(`No login flow is wired for engine '${engineId}' (anthropic)`);
  }
}

export function registerLoginCommand(program: Command, globals: () => GlobalOptions): void {
  program
    .command('login [engine]')
    .description("run an engine's login in this terminal (anthropic by default)")
    .action((engine: string | undefined) =>
      withCli(globals(), async () => {
        const { command, args } = loginCommandFor(engine ?? 'anthropic');
        // A neutral cwd: logins are account-level and must not register your project as a workspace.
        const cwd = join(tmpdir(), 'taliqraph-login');
        await mkdir(cwd, { recursive: true });
        const exitCode = await new Promise<number>((resolve, reject) => {
          const child = spawn(command, [...args], {
            cwd,
            stdio: 'inherit',
            shell: process.platform === 'win32',
          });
          child.on('error', (cause) =>
            reject(new Error(`Could not start '${command}': ${cause.message}`)),
          );
          child.on('exit', (code) => resolve(code ?? 0));
        });
        process.exitCode = exitCode === 0 ? EXIT.ok : EXIT.error;
      }),
    );
}
