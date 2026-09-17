import { Command } from 'commander';
import { registerDoctorCommand } from './commands/doctor';
import { registerLintCommand } from './commands/lint';
import { registerLoginCommand } from './commands/login';
import { registerPackCommands } from './commands/pack';
import { OUTPUT_FORMATS, runCommand } from './commands/run';
import { parseTaskInputs } from './commands/task-inputs';
import type { GlobalOptions } from './context';
import { parseEnvPairs } from './env-pairs';
import { EXIT } from './exit-codes';
import { Output } from './output';
import { CLI_VERSION } from '../version';

interface RootOptions extends GlobalOptions {
  readonly print?: boolean;
  readonly input: readonly string[];
  readonly inputs?: string;
  readonly mcpServers?: string;
  readonly verbose?: boolean;
  /** commander's `--no-stream`: true unless the flag is given. */
  readonly stream?: boolean;
  readonly outputFormat: string;
  readonly secret: readonly string[];
  readonly env: readonly string[];
}

const collect = (pair: string, all: string[]): string[] => [...all, pair];

/** The whole command tree; global options are read at action time so they work before or after a subcommand. */
export function buildProgram(): Command {
  const program = new Command()
    .name('taliqraph')
    .description(`Taliqraph - run workflows of agents, scripts and gates, from the terminal.`)
    .version(CLI_VERSION, '-v, --version')
    .option('--cwd <folder>', 'the working folder (default: the current one)')
    .option('--json', 'machine-readable output where a command supports it')
    .option('--no-color', 'plain output')
    .option('-q, --quiet', 'results and errors only')
    .option(
      '-p, --print',
      'nobody is watching: gates approve themselves (all items ticked, the default choice), over budget exits 4',
    )
    .option(
      '-i, --input <name=value>',
      'one input of the workflow (repeat per input)',
      collect,
      [] as string[],
    )
    .option(
      '--secret <NAME=value>',
      'a secret for this run only, never stored (repeat per secret); else the environment',
      collect,
      [] as string[],
    )
    .option(
      '--env <NAME=value>',
      "a host variable the workflow's env: pass-through may hand to steps (repeat per variable)",
      collect,
      [] as string[],
    )
    .option('--inputs <json|file>', 'every input at once - a JSON object, or a path to one')
    .option(
      '--mcp-servers <file>',
      'MCP servers the agents may use, and lint checks against: a JSON array of { name, kind, ... }',
    )
    .option('--output-format <format>', OUTPUT_FORMATS.join(' | '), 'text')
    .option('--verbose', 'agent prose and tool calls in the feed')
    .option(
      '--no-stream',
      "do not stream an agent's prose as it writes; the finished text still arrives",
    )
    .argument(
      '[workflow]',
      'the workflow to run: a package folder or a bundle file; gates are answered here unless -p',
    )
    .action(async (workflowName: string | undefined, options: RootOptions) => {
      if (!workflowName) {
        if (options.print) {
          program.error('-p needs a workflow: -p <workflow> --input name=value …', {
            exitCode: EXIT.problems,
          });
        }
        program.outputHelp();
        return;
      }
      const outputFormat = OUTPUT_FORMATS.find((format) => format === options.outputFormat);
      if (!outputFormat) {
        program.error(`--output-format must be one of ${OUTPUT_FORMATS.join(', ')}`, {
          exitCode: EXIT.problems,
        });
        return;
      }
      let inputs: Record<string, unknown> = {};
      let secrets: Record<string, string> = {};
      let env: Record<string, string> = {};
      try {
        secrets = parseEnvPairs(options.secret);
        env = parseEnvPairs(options.env);
        inputs = parseTaskInputs(options.input, options.inputs, options.cwd ?? process.cwd());
      } catch (cause) {
        program.error(cause instanceof Error ? cause.message : String(cause), {
          exitCode: EXIT.problems,
        });
        return;
      }
      const out = new Output({
        json: options.json ?? false,
        quiet: options.quiet ?? false,
        color: (options.color ?? true) && process.stdout.isTTY === true && !process.env['NO_COLOR'],
      });
      await runCommand(
        workflowName,
        inputs,
        {
          outputFormat,
          print: options.print ?? false,
          ...(options.cwd ? { cwd: options.cwd } : {}),
          ...(options.mcpServers ? { mcpServersFile: options.mcpServers } : {}),
          ...(options.verbose ? { verbose: true } : {}),
          ...(options.stream === false ? { stream: false } : {}),
          secrets,
          env,
        },
        out,
      );
    });

  const globals = (): GlobalOptions => program.opts<RootOptions>();
  registerLintCommand(program, globals);
  registerPackCommands(program, globals);
  registerLoginCommand(program, globals);
  registerDoctorCommand(program, globals);
  return program;
}
