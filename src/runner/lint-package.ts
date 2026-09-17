import type { McpRequirement } from '../definitions/workflow/mcp-requirements';
import type { DefinitionProblem, ResolvedDefinitions } from '../definitions/definition-set';
import type { WorkflowDefinition } from '../definitions/workflow/workflow-definition';
import type { WorkflowLintResult } from '../definitions/workflow/workflow-problem';
import { lintWorkflow } from '../definitions/workflow/lint-workflow';
import { requiredMcpServers } from '../definitions/workflow/mcp-requirements';
import type { LoadedPackage } from './load-package';
import { loadPackage } from './load-package';

export interface LintPackageOptions {
  /** The MCP servers the host can offer; an agent naming another one is reported as missing. */
  readonly mcpServers?: readonly string[];
}

export interface PackageLintResult {
  readonly name: string;
  readonly workflow: WorkflowDefinition;
  /** What the workflow resolves against: the package's members and nested packages. */
  readonly scope: ResolvedDefinitions;
  readonly lint: WorkflowLintResult;
  /** Required MCP servers no offered server satisfies. */
  readonly missingMcp: readonly McpRequirement[];
  /** Files in the package that did not parse - they make everything they define invisible. */
  readonly problems: readonly DefinitionProblem[];
}

/**
 * Loads a package (a folder or a bundle file) and lints its workflow against
 * its own scope, without running anything. The same checks a run makes before
 * it starts.
 */
export async function lintPackage(
  source: string,
  options: LintPackageOptions = {},
): Promise<PackageLintResult> {
  const loaded = await loadPackage(source);
  return lintLoadedPackage(loaded, options.mcpServers ?? []);
}

/** The linter over a loaded package, plus the MCP servers its agents need but the host did not offer. */
export function lintLoadedPackage(
  loaded: LoadedPackage,
  configuredMcp: readonly string[],
): PackageLintResult {
  const { name, workflow, scope, problems } = loaded;
  const lint = lintWorkflow(workflow, {
    agentMcp: new Map([...scope.agents.values()].map((agent) => [agent.name, agent.tools.mcp])),
    mcpServers: configuredMcp,
    agentNames: [...scope.agents.keys()],
    workflowNames: [...scope.workflows.keys()],
    scripts: [...scope.scripts.values()],
    // Without these every `<step>.<field>` passes, because the linter has no
    // shape to hold it against - the field checks only work if it knows what
    // each agent and script says it reports.
    agentReports: reportsOf(scope.agents.values()),
    scriptReports: reportsOf(scope.scripts.values()),
  });
  const missingMcp = requiredMcpServers(
    workflow,
    (agent) => scope.agents.get(agent),
    (child) => scope.workflows.get(child),
  ).filter((requirement) => !requirement.optional && !configuredMcp.includes(requirement.name));
  return { name, workflow, scope, lint, missingMcp, problems };
}

/** Name → report skeleton, for the definitions that declare one. */
function reportsOf(
  definitions: Iterable<{ readonly name: string; readonly reportExample?: string }>,
): Record<string, string> {
  const reports: Record<string, string> = {};
  for (const definition of definitions) {
    if (definition.reportExample) {
      reports[definition.name] = definition.reportExample;
    }
  }
  return reports;
}
