import type { DefinitionSet, PackagePath, WorkflowPackage } from '../definition-set';
import type { WorkflowStep } from './workflow-step';

/**
 * Something a package's steps name that lives OUTSIDE the package:
 * a loose piece on the shelf, or a member of another package. It resolves on
 * this machine through the fallback and would be missing anywhere the
 * package is copied to.
 */
export interface OutsideReference {
  readonly kind: 'agent' | 'script' | 'skill' | 'workflow';
  readonly name: string;
  /** `<package>/<step>` (or `<agent>` for a skill). */
  readonly via: string;
  /** Where it was found: the loose pieces (empty) or the package holding it. */
  readonly from: PackagePath;
}

/** Every reference of a top-level package (nested packages included) that resolves outside it. */
export function outsidePackageReferences(set: DefinitionSet, name: string): OutsideReference[] {
  const root = set.packages.get(name);
  if (!root) {
    return [];
  }
  const out: OutsideReference[] = [];
  const seen = new Set<string>();
  const add = (ref: OutsideReference): void => {
    const key = `${ref.kind}:${ref.name}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(ref);
    }
  };
  const locate = (
    kind: 'agent' | 'script' | 'skill',
    itemName: string,
  ): PackagePath | undefined => {
    const shelf = set.pieces[`${kind}s` as 'agents' | 'scripts' | 'skills'];
    if (shelf.has(itemName)) {
      return [];
    }
    const search = (packages: ReadonlyMap<string, WorkflowPackage>): PackagePath | undefined => {
      for (const pkg of packages.values()) {
        if (pkg[`${kind}s` as 'agents' | 'scripts' | 'skills'].has(itemName)) {
          return pkg.packagePath;
        }
        const nested = search(pkg.workflows);
        if (nested) {
          return nested;
        }
      }
      return undefined;
    };
    return search(set.packages);
  };
  const visit = (pkg: WorkflowPackage): void => {
    const label = pkg.packagePath.join('/');
    const useAgent = (agentName: string, stepId: string): void => {
      const own = pkg.agents.get(agentName);
      if (!own) {
        const from = locate('agent', agentName);
        if (from) {
          add({ kind: 'agent', name: agentName, via: `${label}/${stepId}`, from });
        }
        return; // unknown anywhere: the linter's error, not ours
      }
      for (const skill of own.definition.skills ?? []) {
        if (!pkg.skills.has(skill)) {
          const from = locate('skill', skill);
          if (from) {
            add({ kind: 'skill', name: skill, via: agentName, from });
          }
        }
      }
    };
    const walk = (steps: readonly WorkflowStep[]): void => {
      for (const step of steps) {
        switch (step.kind) {
          case 'agent':
            useAgent(step.agent, step.id);
            break;
          case 'foreach':
            useAgent(step.template.agent, step.id);
            break;
          case 'script': {
            if (!pkg.scripts.has(step.command)) {
              const from = locate('script', step.command);
              if (from) {
                add({ kind: 'script', name: step.command, via: `${label}/${step.id}`, from });
              }
            }
            break;
          }
          case 'workflow': {
            const nested = pkg.workflows.get(step.workflow);
            if (nested) {
              visit(nested);
            } else if (set.packages.has(step.workflow)) {
              add({
                kind: 'workflow',
                name: step.workflow,
                via: `${label}/${step.id}`,
                from: set.packages.get(step.workflow)?.packagePath ?? [step.workflow],
              });
            }
            break;
          }
          case 'parallel':
            for (const branch of step.children) {
              walk(branch);
            }
            break;
          case 'condition':
            if (step.then.kind === 'steps') {
              walk(step.then.steps);
            }
            if (step.else?.kind === 'steps') {
              walk(step.else.steps);
            }
            break;
          default:
            break;
        }
      }
    };
    walk(pkg.workflow.definition.steps);
  };
  visit(root);
  return out;
}
