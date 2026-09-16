import type { ConditionBranchStep, WorkflowStep } from './workflow-step';

export function validateStepReferences(steps: readonly WorkflowStep[]): string[] {
  const issues: string[] = [];
  const seenIds = new Set<string>();

  for (const step of steps) {
    if (seenIds.has(step.id)) {
      issues.push(`Duplicate step id '${step.id}'`);
    }
    seenIds.add(step.id);
  }

  // An output alias is a second name for a step's result (it is registered under
  // both), so it must not shadow another step's id or alias, or reads would be ambiguous.
  const owners = new Map<string, string>(steps.map((step) => [step.id, step.id]));
  for (const step of steps) {
    if (
      (step.kind === 'agent' || step.kind === 'script') &&
      step.output &&
      step.output !== step.id
    ) {
      const owner = owners.get(step.output);
      if (owner && owner !== step.id) {
        issues.push(
          `Output name '${step.output}' on step '${step.id}' collides with step '${owner}'`,
        );
      }
      owners.set(step.output, step.id);
    }
  }

  for (const step of steps) {
    if (
      (step.kind === 'workflow' ||
        step.kind === 'agent' ||
        step.kind === 'parallel' ||
        step.kind === 'foreach') &&
      step.onBlocking &&
      !seenIds.has(step.onBlocking.gotoStepId)
    ) {
      issues.push(`Step '${step.id}' loops back to unknown step '${step.onBlocking.gotoStepId}'`);
    }
    if (step.kind === 'condition') {
      if (step.then.kind === 'goto' && !seenIds.has(step.then.stepId)) {
        issues.push(`Condition '${step.id}' targets unknown step '${step.then.stepId}'`);
      }
      if (step.else?.kind === 'goto' && !seenIds.has(step.else.stepId)) {
        issues.push(`Condition '${step.id}' targets unknown step '${step.else.stepId}'`);
      }
      if (step.then.kind === 'steps') {
        issues.push(...validateBranchReferences(`'${step.id}'.then`, step.then.steps, seenIds));
      }
      if (step.else?.kind === 'steps') {
        issues.push(...validateBranchReferences(`'${step.id}'.else`, step.else.steps, seenIds));
      }
    }
    if (step.kind === 'while' && !seenIds.has(step.gotoStepId)) {
      issues.push(`While '${step.id}' loops back to unknown step '${step.gotoStepId}'`);
    }
    if (step.kind === 'goto' && !seenIds.has(step.targetStepId)) {
      issues.push(`Go to '${step.id}' targets unknown step '${step.targetStepId}'`);
    }
    if (step.kind === 'parallel') {
      step.children.forEach((branch, index) => {
        issues.push(...validateBranchReferences(`'${step.id}'[${index}]`, branch, new Set()));
      });
    }
  }

  return issues;
}

/**
 * A branch runs as its own tiny scope: onBlocking/condition/while targets
 * inside it must resolve to another step within that SAME branch, never the
 * outer pipeline or a sibling branch. This mirrors how a sub-workflow's
 * onBlocking target is scoped to its own definition. A goto is the exception:
 * it may also target a step of any enclosing pipeline (`outerIds`), which is
 * how a lane loops back to an earlier top-level step, except from inside a
 * fork, where nothing outside is reachable.
 */
function validateBranchReferences(
  scope: string,
  steps: readonly ConditionBranchStep[],
  outerIds: ReadonlySet<string>,
): string[] {
  const issues: string[] = [];
  const localIds = new Set<string>();
  for (const step of steps) {
    if (localIds.has(step.id)) {
      issues.push(`Duplicate step id '${step.id}' in branch ${scope}`);
    }
    localIds.add(step.id);
  }
  const reachable = new Set([...outerIds, ...localIds]);
  for (const step of steps) {
    if (step.kind === 'goto' && !reachable.has(step.targetStepId)) {
      issues.push(
        `Go to '${step.id}' in branch ${scope} targets unknown step '${step.targetStepId}'`,
      );
    }
    if (
      (step.kind === 'agent' || step.kind === 'workflow') &&
      step.onBlocking &&
      !localIds.has(step.onBlocking.gotoStepId)
    ) {
      issues.push(
        `Step '${step.id}' in branch ${scope} loops back to unknown step '${step.onBlocking.gotoStepId}'`,
      );
    }
    if (step.kind === 'while' && !localIds.has(step.gotoStepId)) {
      issues.push(
        `While '${step.id}' in branch ${scope} loops back to unknown step '${step.gotoStepId}'`,
      );
    }
    if (step.kind === 'condition') {
      if (step.then.kind === 'goto' && !localIds.has(step.then.stepId)) {
        issues.push(
          `Condition '${step.id}' in branch ${scope} targets unknown step '${step.then.stepId}'`,
        );
      }
      if (step.else?.kind === 'goto' && !localIds.has(step.else.stepId)) {
        issues.push(
          `Condition '${step.id}' in branch ${scope} targets unknown step '${step.else.stepId}'`,
        );
      }
      if (step.then.kind === 'steps') {
        issues.push(
          ...validateBranchReferences(`${scope}/'${step.id}'.then`, step.then.steps, reachable),
        );
      }
      if (step.else?.kind === 'steps') {
        issues.push(
          ...validateBranchReferences(`${scope}/'${step.id}'.else`, step.else.steps, reachable),
        );
      }
    }
    if (step.kind === 'parallel') {
      step.children.forEach((branch, index) => {
        issues.push(
          ...validateBranchReferences(`${scope}/'${step.id}'[${index}]`, branch, new Set()),
        );
      });
    }
  }
  return issues;
}
