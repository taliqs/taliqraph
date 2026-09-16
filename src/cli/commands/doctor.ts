import type { EngineAuthStatus } from '../../engines/engine-adapter';
import { createDefaultEngines } from '../../engines/default-engines';
import type { Command } from 'commander';
import type { CliContext, GlobalOptions } from '../context';
import { withCli } from '../context';
import type { Output } from '../output';
import { table } from '../output';
import { CLI_VERSION } from '../../version';

/** `doctor`: engines and their sign-ins, node. */
export function registerDoctorCommand(program: Command, globals: () => GlobalOptions): void {
  program
    .command('doctor')
    .description('check engines, logins and node')
    .action(() => withCli(globals(), doctorCommand));
}

function engineState(status: EngineAuthStatus, out: Output): string {
  switch (status.state) {
    case 'authenticated':
      return out.ok(`authenticated${status.account ? ` (${status.account})` : ''}`);
    case 'not-installed':
      return out.dim('not installed');
    default:
      return out.warn(status.state);
  }
}

export async function doctorCommand(context: CliContext): Promise<void> {
  const { out } = context;
  const engines = await Promise.all(
    createDefaultEngines()
      .list()
      .map(async (engine) => ({ id: engine.id, status: await engine.authStatus() })),
  );
  const report = {
    version: CLI_VERSION,
    platform: process.platform,
    node: process.version,
    engines: engines.map(({ id, status }) => ({
      id,
      authState: status.state,
      account: 'account' in status ? (status.account ?? null) : null,
    })),
  };
  out.result(report, () =>
    table([
      ['Taliqraph', report.version],
      ['platform', `${report.platform} · node ${report.node}`],
      ...engines.map(({ id, status }) => [id, engineState(status, out)]),
    ]),
  );
}
