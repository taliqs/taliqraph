import type { WorkflowStep } from './workflow-step';

/** The name a step's result is stored under: its `output:` or, failing that, its id. */
export function outputNameOf(step: WorkflowStep): string {
  if ((step.kind === 'agent' || step.kind === 'script') && step.output) {
    return step.output;
  }
  return step.id;
}
