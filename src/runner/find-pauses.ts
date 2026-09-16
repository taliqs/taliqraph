import type { WorkflowDefinition } from '../definitions/workflow/workflow-definition';
import type { WorkflowStep } from '../definitions/workflow/workflow-step';

/**
 * Every step at which the workflow can stop for a person, before it runs:
 * gates, and review steps whose blocking policy ends in a gate - through
 * fork branches, condition lanes and the workflows the steps name. Nested
 * ids read `parent/child`, the way the run emits them.
 */
export function pausingStepIds(
  workflow: WorkflowDefinition,
  resolveWorkflow: (name: string) => WorkflowDefinition | undefined,
): string[] {
  const found: string[] = [];
  const visiting = new Set<string>([workflow.name]);
  const visit = (steps: readonly WorkflowStep[], prefix: string): void => {
    for (const step of steps) {
      const id = `${prefix}${step.id}`;
      const gates = 'onBlocking' in step && step.onBlocking?.then === 'gate';
      if (step.kind === 'gate' || gates) {
        found.push(id);
      }
      switch (step.kind) {
        case 'parallel':
          for (const branch of step.children) {
            visit(branch, `${id}/`);
          }
          break;
        case 'condition':
          if (step.then.kind === 'steps') {
            visit(step.then.steps, `${id}/`);
          }
          if (step.else?.kind === 'steps') {
            visit(step.else.steps, `${id}/`);
          }
          break;
        case 'foreach':
          if (step.template.onBlocking?.then === 'gate') {
            found.push(`${id}/${step.template.id}`);
          }
          break;
        case 'workflow': {
          const child = resolveWorkflow(step.workflow);
          if (child && !visiting.has(child.name)) {
            visiting.add(child.name);
            visit(child.steps, `${id}/`);
            visiting.delete(child.name);
          }
          break;
        }
        default:
          break;
      }
    }
  };
  visit(workflow.steps, '');
  return [...new Set(found)];
}
