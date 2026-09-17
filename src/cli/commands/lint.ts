import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { Command } from 'commander';
import type { DefinitionProblem } from '../../definitions/definition-set';
import type { McpRequirement } from '../../definitions/workflow/mcp-requirements';
import type {
  WorkflowLintResult,
  WorkflowProblem,
} from '../../definitions/workflow/workflow-problem';
import { lintPackage } from '../../runner/lint-package';
import type { CliContext, GlobalOptions } from '../context';
import { withCli } from '../context';
import { EXIT } from '../exit-codes';
import type { Output } from '../output';
import { readMcpServersFile } from './mcp-servers-file';

interface LintReport {
  readonly workflow: string;
  readonly result: WorkflowLintResult;
  /** MCP servers the agents need that were not offered. */
  readonly missingMcp: readonly McpRequirement[];
  /** Files that did not parse: nothing they define is visible to the workflow. */
  readonly problems: readonly DefinitionProblem[];
}

export interface LintOptions {
  readonly strict?: boolean;
  /** The servers file from the global `--mcp-servers`; the root command owns the flag. */
  readonly mcpServers?: string;
}

const PACKAGE_MANIFESTS = ['workflow.yaml', 'workflow.yml'];

/** `lint [target]`: the same checks a run makes before it starts. */
export function registerLintCommand(program: Command, globals: () => GlobalOptions): void {
  program
    .command('lint [target]')
    .description(
      'lint a workflow package: a folder or a bundle file (default: the current folder); exit 2 on errors',
    )
    .option('--strict', 'warnings fail too')
    .action((target: string | undefined, options: { strict?: boolean }) =>
      withCli(globals(), (context) => lintCommand(context, target, { ...options, ...globals() })),
    );
}

export async function lintCommand(
  context: CliContext,
  target: string | undefined,
  options: LintOptions,
): Promise<void> {
  const source = resolve(context.cwd, target ?? '.');
  if (!existsSync(source)) {
    throw new Error(`${target ?? source} does not exist`);
  }
  if (!target && !PACKAGE_MANIFESTS.some((manifest) => existsSync(join(source, manifest)))) {
    throw new Error(`${source} is not a workflow package folder - name one, or a bundle file`);
  }
  const mcpServers = options.mcpServers
    ? (await readMcpServersFile(options.mcpServers, context.cwd)).map((server) => server.name)
    : [];
  // A package that will not load is the worst thing lint can find, not an
  // unexpected failure: it exits 2 like every other lint problem, so a CI job can
  // tell a broken workflow from a workflow that ran and failed.
  let linted;
  try {
    linted = await lintPackage(source, { mcpServers });
  } catch (cause) {
    context.out.error(cause instanceof Error ? cause.message : String(cause));
    process.exitCode = EXIT.problems;
    return;
  }
  const report: LintReport = {
    workflow: linted.name,
    result: linted.lint,
    missingMcp: linted.missingMcp,
    problems: linted.problems,
  };
  const failing =
    report.problems.length > 0 ||
    report.missingMcp.length > 0 ||
    (options.strict
      ? report.result.problems.some((problem) => problem.severity !== 'info')
      : !report.result.ok);
  context.out.result(report, () => renderReport(report, context));
  process.exitCode = failing ? EXIT.problems : EXIT.ok;
}

function renderReport(
  { workflow, result, missingMcp, problems }: LintReport,
  context: CliContext,
): string[] {
  const { out } = context;
  const errorCount = result.counts.error + missingMcp.length + problems.length;
  const errors =
    errorCount === 0 ? out.ok('ok') : out.bad(`${errorCount} error${errorCount === 1 ? '' : 's'}`);
  const warnings = result.counts.warning
    ? `, ${out.warn(`${result.counts.warning} warning${result.counts.warning === 1 ? '' : 's'}`)}`
    : '';
  return [
    `${workflow}: ${errors}${warnings}`,
    // a file that does not parse comes first: it is why everything it defines looks missing
    ...problems.flatMap((problem) => [
      `  ${out.bad('error')} ${out.dim('unreadable')} ${basename(dirname(problem.filePath))}/${basename(problem.filePath)}: ${problem.message}`,
      ...problem.issues.map((issue) => `      ${issue}`),
    ]),
    ...result.problems.map((problem) => `  ${renderProblem(problem, out)}`),
    ...missingMcp.map(
      (requirement) =>
        `  ${out.bad('error')} ${out.dim('mcp-missing')} ${requirement.agents.join(', ')}: needs the MCP server '${requirement.name}', which was not offered`,
    ),
  ];
}

function badgeOf(severity: WorkflowProblem['severity'], out: Output): string {
  switch (severity) {
    case 'error':
      return out.bad('error');
    case 'warning':
      return out.warn('warn ');
    default:
      return out.dim('info ');
  }
}

function renderProblem(problem: WorkflowProblem, out: Output): string {
  const badge = badgeOf(problem.severity, out);
  const where = [problem.where.stepId, problem.where.innerStepId, problem.where.field]
    .filter(Boolean)
    .join('.');
  const hint = problem.hint ? out.dim(` - ${problem.hint}`) : '';
  return `${badge} ${out.dim(problem.code)} ${where ? `${where}: ` : ''}${problem.message}${hint}`;
}
