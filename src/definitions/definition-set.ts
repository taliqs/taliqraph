import type { AgentDefinition } from './agent/agent-definition';
import { parseAgentDefinition } from './agent/parse-agent-definition';
import { parseScriptDefinition } from './script/parse-script-definition';
import type { ScriptDefinition } from './script/script-definition';
import type { SkillDefinition } from './skill/skill-definition';
import { parseSkillDefinition } from './skill/parse-skill-definition';
import type { StandardDefinition } from './standard/standard-definition';
import { parseStandardDefinition } from './standard/parse-standard-definition';
import type { WorkflowDefinition } from './workflow/workflow-definition';
import { parseWorkflowDefinition } from './workflow/parse-workflow-definition';
import type { WorkflowStep } from './workflow/workflow-step';

export type DefinitionOrigin = 'built-in' | 'global' | 'project';
export type DefinitionKind = 'agent' | 'workflow' | 'standard' | 'skill' | 'script';

/**
 * Where a definition lives: inside the package `workflows/<a>/` (path
 * `['a']`), inside a package nested in it (`['a', 'b']`), or loose on the
 * shelf as a piece (absent).
 */
export type PackagePath = readonly string[];

/** One raw definition file (or embedded built-in) before parsing. */
export interface DefinitionSource {
  readonly kind: DefinitionKind;
  readonly origin: DefinitionOrigin;
  /** Absolute path for on-disk sources; absent for embedded built-ins. */
  readonly filePath?: string;
  readonly content: string;
  /** The package folder this file belongs to; absent for a loose piece. */
  readonly packagePath?: PackagePath;
}

/** A definition file that did not load; hosts surface these. */
export interface DefinitionProblem {
  readonly filePath: string;
  readonly message: string;
  readonly issues: readonly string[];
}

export interface LoadedAgent {
  readonly definition: AgentDefinition;
  readonly origin: DefinitionOrigin;
  readonly filePath?: string;
  readonly packagePath?: PackagePath;
}

export interface LoadedWorkflow {
  readonly definition: WorkflowDefinition;
  readonly origin: DefinitionOrigin;
  readonly filePath?: string;
  readonly packagePath?: PackagePath;
}

export interface LoadedSkill {
  readonly definition: SkillDefinition;
  readonly origin: DefinitionOrigin;
  readonly filePath?: string;
  readonly packagePath?: PackagePath;
}

export interface LoadedStandard {
  readonly definition: StandardDefinition;
  readonly origin: DefinitionOrigin;
  readonly filePath?: string;
  readonly packagePath?: PackagePath;
}

export interface LoadedScript {
  readonly definition: ScriptDefinition;
  readonly origin: DefinitionOrigin;
  /** The manifest (`…/scripts/<name>/script.yaml`); the code lives next to it. */
  readonly filePath?: string;
  readonly packagePath?: PackagePath;
}

/**
 * A workflow package: the folder `workflows/<name>/`, with its
 * `workflow.yaml` and every agent, script, standard, skill and nested
 * package it carries. An embedded built-in is a package with no `dir` and no
 * members; its steps fall back to the loose pieces.
 */
export interface WorkflowPackage {
  readonly name: string;
  readonly origin: DefinitionOrigin;
  readonly packagePath: PackagePath;
  /** The package folder; absent for an embedded built-in. */
  readonly dir?: string;
  readonly workflow: LoadedWorkflow;
  readonly agents: ReadonlyMap<string, LoadedAgent>;
  readonly scripts: ReadonlyMap<string, LoadedScript>;
  readonly standards: ReadonlyMap<string, LoadedStandard>;
  readonly skills: ReadonlyMap<string, LoadedSkill>;
  readonly workflows: ReadonlyMap<string, WorkflowPackage>;
}

/** Plain name → definition maps: what a run resolves against (see packageScope). */
export interface ResolvedDefinitions {
  readonly agents: ReadonlyMap<string, AgentDefinition>;
  readonly workflows: ReadonlyMap<string, WorkflowDefinition>;
  readonly standards: ReadonlyMap<string, StandardDefinition>;
  readonly skills: ReadonlyMap<string, SkillDefinition>;
  readonly scripts: ReadonlyMap<string, ScriptDefinition>;
}

export interface DefinitionSet {
  /**
   * The union view by name: loose pieces, then every package's members
   * (a later package wins a name clash). Listings and pickers read this;
   * a run resolves through `packageScope` instead.
   */
  readonly agents: ReadonlyMap<string, LoadedAgent>;
  readonly workflows: ReadonlyMap<string, LoadedWorkflow>;
  readonly standards: ReadonlyMap<string, LoadedStandard>;
  readonly skills: ReadonlyMap<string, LoadedSkill>;
  readonly scripts: ReadonlyMap<string, LoadedScript>;
  /** Top-level packages by workflow name; nested packages hang under their parent. */
  readonly packages: ReadonlyMap<string, WorkflowPackage>;
  /** The shelf: what lives outside every package. */
  readonly pieces: {
    readonly agents: ReadonlyMap<string, LoadedAgent>;
    readonly scripts: ReadonlyMap<string, LoadedScript>;
    readonly standards: ReadonlyMap<string, LoadedStandard>;
    readonly skills: ReadonlyMap<string, LoadedSkill>;
  };
  readonly problems: readonly DefinitionProblem[];
}

/** The folder a file path points into, whichever slash the platform uses. */
function dirOf(filePath: string): string {
  return filePath.replace(/[\\/][^\\/]*$/, '');
}

/**
 * Merges definition layers into one resolved set. Source order is the layer
 * order: later sources shadow earlier ones with the same name (built-in →
 * global → project). A file that fails to parse becomes a problem and shadows
 * nothing, so the layer underneath stays usable. Workflow `extends` is
 * resolved last, against the shadowed set.
 */
export function buildDefinitionSet(sources: readonly DefinitionSource[]): DefinitionSet {
  const agents = new Map<string, LoadedAgent>();
  const workflows = new Map<string, LoadedWorkflow>();
  const standards = new Map<string, LoadedStandard>();
  const skills = new Map<string, LoadedSkill>();
  const scripts = new Map<string, LoadedScript>();
  const problems: DefinitionProblem[] = [];
  const pieces = {
    agents: new Map<string, LoadedAgent>(),
    scripts: new Map<string, LoadedScript>(),
    standards: new Map<string, LoadedStandard>(),
    skills: new Map<string, LoadedSkill>(),
  };
  const packages = new Map<string, MutablePackage>();

  // Loose pieces first, packages after: a package member wins a name clash in the union view.
  const ordered = [...sources].sort((a, b) => (a.packagePath ? 1 : 0) - (b.packagePath ? 1 : 0));
  for (const source of ordered) {
    const scope = source.origin === 'project' ? 'project' : 'global';
    const at = source.filePath ?? `built-in ${source.kind}`;
    const where = {
      origin: source.origin,
      ...(source.filePath ? { filePath: source.filePath } : {}),
      ...(source.packagePath ? { packagePath: source.packagePath } : {}),
    };
    const pkg = source.packagePath ? packageNode(packages, source.packagePath, source) : null;
    if (source.kind === 'agent') {
      const parsed = parseAgentDefinition(source.content, scope);
      if (parsed.ok) {
        const loaded = { definition: parsed.value, ...where };
        agents.set(parsed.value.name, loaded);
        (pkg ? pkg.agents : pieces.agents).set(parsed.value.name, loaded);
      } else {
        problems.push({ filePath: at, message: parsed.error.message, issues: parsed.error.issues });
      }
    } else if (source.kind === 'workflow') {
      const parsed = parseWorkflowDefinition(source.content, scope);
      if (parsed.ok) {
        const loaded = { definition: parsed.value, ...where };
        workflows.set(parsed.value.name, loaded);
        if (pkg) {
          pkg.workflow = loaded;
        } else {
          // an embedded built-in: a package with no folder and no members
          const node = packageNode(packages, [parsed.value.name], source);
          node.workflow = loaded;
        }
      } else {
        problems.push({ filePath: at, message: parsed.error.message, issues: parsed.error.issues });
      }
    } else if (source.kind === 'skill') {
      const parsed = parseSkillDefinition(source.content, scope);
      if (parsed.ok) {
        const loaded = { definition: parsed.value, ...where };
        skills.set(parsed.value.name, loaded);
        (pkg ? pkg.skills : pieces.skills).set(parsed.value.name, loaded);
      } else {
        problems.push({ filePath: at, message: parsed.error.message, issues: parsed.error.issues });
      }
    } else if (source.kind === 'script') {
      // the folder holding script.yaml; the runner resolves `run` against it
      const dir = source.filePath ? dirOf(source.filePath) : undefined;
      const parsed = parseScriptDefinition(source.content, scope, dir ? { dir } : {});
      if (parsed.ok) {
        const loaded = { definition: parsed.value, ...where };
        scripts.set(parsed.value.name, loaded);
        (pkg ? pkg.scripts : pieces.scripts).set(parsed.value.name, loaded);
      } else {
        problems.push({ filePath: at, message: parsed.error.message, issues: parsed.error.issues });
      }
    } else {
      const parsed = parseStandardDefinition(source.content, scope);
      if (parsed.ok) {
        const loaded = { definition: parsed.value, ...where };
        standards.set(parsed.value.name, loaded);
        (pkg ? pkg.standards : pieces.standards).set(parsed.value.name, loaded);
      } else {
        problems.push({ filePath: at, message: parsed.error.message, issues: parsed.error.issues });
      }
    }
  }

  resolveWorkflowExtends(workflows, problems);
  const finished = finishPackages(packages, workflows, problems);
  return { agents, workflows, standards, skills, scripts, packages: finished, pieces, problems };
}

interface MutablePackage {
  readonly name: string;
  origin: DefinitionOrigin;
  readonly packagePath: PackagePath;
  dir?: string;
  workflow?: LoadedWorkflow;
  readonly agents: Map<string, LoadedAgent>;
  readonly scripts: Map<string, LoadedScript>;
  readonly standards: Map<string, LoadedStandard>;
  readonly skills: Map<string, LoadedSkill>;
  readonly workflows: Map<string, MutablePackage>;
}

/** The package node for a path, created on first sight (a member may be read before its workflow.yaml). */
function packageNode(
  roots: Map<string, MutablePackage>,
  path: PackagePath,
  source: DefinitionSource,
): MutablePackage {
  let level = roots;
  let node: MutablePackage | undefined;
  path.forEach((name, depth) => {
    node = level.get(name);
    if (!node) {
      node = {
        name,
        origin: source.origin,
        packagePath: path.slice(0, depth + 1),
        agents: new Map(),
        scripts: new Map(),
        standards: new Map(),
        skills: new Map(),
        workflows: new Map(),
      };
      level.set(name, node);
    }
    level = node.workflows;
  });
  const found = node as MutablePackage;
  if (source.kind === 'workflow') {
    found.origin = source.origin;
    if (source.filePath && source.packagePath) {
      found.dir = dirOf(source.filePath);
    }
  }
  return found;
}

/** Packages whose workflow.yaml never parsed are dropped (their problem is already recorded); `extends` results are reflected. */
function finishPackages(
  nodes: Map<string, MutablePackage>,
  workflows: ReadonlyMap<string, LoadedWorkflow>,
  problems: DefinitionProblem[],
  topLevel = true,
): ReadonlyMap<string, WorkflowPackage> {
  const out = new Map<string, WorkflowPackage>();
  for (const [name, node] of nodes) {
    if (!node.workflow) {
      if (node.dir) {
        problems.push({
          filePath: node.dir,
          message: `package '${node.packagePath.join('/')}' has no usable workflow.yaml`,
          issues: [],
        });
      }
      continue;
    }
    const resolved = topLevel ? workflows.get(name) : undefined;
    const workflow =
      resolved && resolved.filePath === node.workflow.filePath ? resolved : node.workflow;
    out.set(name, {
      name,
      origin: node.origin,
      packagePath: node.packagePath,
      ...(node.dir ? { dir: node.dir } : {}),
      workflow,
      agents: node.agents,
      scripts: node.scripts,
      standards: node.standards,
      skills: node.skills,
      workflows: finishPackages(node.workflows, workflows, problems, false),
    });
  }
  return out;
}

/**
 * What a run of `workflowName` resolves against: the package's members and its
 * nested packages', with the loose pieces underneath so an un-migrated layout
 * still runs. Every top-level package's workflow is reachable too, so
 * `workflow: <name>` finds a sibling when the package carries no nested copy.
 */
export function packageScope(set: DefinitionSet, workflowName: string): ResolvedDefinitions {
  const agents = new Map<string, AgentDefinition>();
  const workflows = new Map<string, WorkflowDefinition>();
  const standards = new Map<string, StandardDefinition>();
  const skills = new Map<string, SkillDefinition>();
  const scripts = new Map<string, ScriptDefinition>();
  const take = <T extends { readonly definition: { readonly name: string } }>(
    into: Map<string, T['definition']>,
    from: ReadonlyMap<string, T>,
  ): void => {
    for (const [name, entry] of from) {
      into.set(name, entry.definition);
    }
  };
  take(agents, set.pieces.agents);
  take(scripts, set.pieces.scripts);
  take(standards, set.pieces.standards);
  take(skills, set.pieces.skills);
  for (const pkg of set.packages.values()) {
    workflows.set(pkg.name, pkg.workflow.definition);
  }
  const visit = (pkg: WorkflowPackage): void => {
    // nested packages first, so the package's own members win a name clash
    for (const nested of pkg.workflows.values()) {
      visit(nested);
      workflows.set(nested.name, nested.workflow.definition);
    }
    take(agents, pkg.agents);
    take(scripts, pkg.scripts);
    take(standards, pkg.standards);
    take(skills, pkg.skills);
  };
  const pkg = set.packages.get(workflowName);
  if (pkg) {
    visit(pkg);
  } else {
    // unknown name: the union view, so the caller's own "unknown workflow" error is what surfaces
    take(agents, set.agents);
    take(scripts, set.scripts);
    take(standards, set.standards);
    take(skills, set.skills);
    for (const [name, entry] of set.workflows) {
      workflows.set(name, entry.definition);
    }
  }
  return { agents, workflows, standards, skills, scripts };
}

/**
 * `extends`: the child starts from the base's steps; a child step whose id
 * matches a base step replaces it in place, any other child step is appended.
 * Chains resolve recursively; cycles and missing bases become problems and the
 * workflow is dropped.
 */
function resolveWorkflowExtends(
  workflows: Map<string, LoadedWorkflow>,
  problems: DefinitionProblem[],
): void {
  const resolved = new Map<string, LoadedWorkflow>();
  const resolve = (name: string, trail: readonly string[]): LoadedWorkflow | null => {
    const cached = resolved.get(name);
    if (cached) {
      return cached;
    }
    const entry = workflows.get(name);
    if (!entry) {
      return null;
    }
    const baseName = entry.definition.extendsName;
    if (!baseName) {
      resolved.set(name, entry);
      return entry;
    }
    const at = entry.filePath ?? `workflow '${name}'`;
    if (trail.includes(name)) {
      problems.push({
        filePath: at,
        message: `extends cycle: ${[...trail, name].join(' → ')}`,
        issues: [],
      });
      return null;
    }
    const base = resolve(baseName, [...trail, name]);
    if (!base) {
      problems.push({
        filePath: at,
        message: `extends '${baseName}', which does not exist`,
        issues: [],
      });
      return null;
    }
    const merged: LoadedWorkflow = {
      ...entry,
      definition: {
        ...entry.definition,
        steps: mergeSteps(base.definition.steps, entry.definition.steps),
      },
    };
    resolved.set(name, merged);
    return merged;
  };

  for (const name of [...workflows.keys()]) {
    const outcome = resolve(name, []);
    if (outcome) {
      workflows.set(name, outcome);
    } else {
      workflows.delete(name);
    }
  }
}

function mergeSteps(
  base: readonly WorkflowStep[],
  overrides: readonly WorkflowStep[],
): readonly WorkflowStep[] {
  const merged = [...base];
  for (const step of overrides) {
    const index = merged.findIndex((existing) => existing.id === step.id);
    if (index >= 0) {
      merged[index] = step;
    } else {
      merged.push(step);
    }
  }
  return merged;
}
