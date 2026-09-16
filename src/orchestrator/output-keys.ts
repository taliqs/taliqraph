import type { ConditionBranchStep, WorkflowStep } from '../definitions/workflow/workflow-step';

/** Internal output key for one for_each item - kept out of the dotted-path namespace. */
export function foreachChildKey(stepId: string, index: number | string): string {
  return `__foreach:${stepId}:${index}`;
}

export function outputKeyOf(step: WorkflowStep): string {
  if ((step.kind === 'agent' || step.kind === 'script') && step.output) {
    return step.output;
  }
  return step.id;
}

/**
 * A lane's headline - the report of its last step that writes one (finish and
 * fail don't). What `<condition>.output` reads, so downstream has one name
 * that works whichever side ran.
 */
export function laneHeadline(
  lane: readonly ConditionBranchStep[],
  outputs: Readonly<Record<string, unknown>>,
): unknown {
  const last = [...lane]
    .reverse()
    .find((entry) => entry.kind !== 'finish' && entry.kind !== 'fail');
  if (!last) {
    return null;
  }
  return outputs[outputKeyOf(last)] ?? outputs[last.id] ?? null;
}

/**
 * Registers a step's result under its id and, when it has one, its `output:`
 * alias - both are valid references downstream. A for_each item clone only
 * has its synthetic key (its id is just the item number). Shared by the live
 * run and replay so both agree byte for byte.
 */
export function recordOutput(
  outputs: Record<string, unknown>,
  step: WorkflowStep,
  value: unknown,
): void {
  const alias = outputKeyOf(step);
  if (!alias.startsWith('__foreach:')) {
    outputs[step.id] = value;
  }
  if (alias !== step.id) {
    outputs[alias] = value;
  }
}

/**
 * A backward jump means every re-visited fork runs its branches AGAIN - the
 * per-child completion memory only exists so crash-RESUME never re-spends.
 */
export function clearForkMemos(
  steps: readonly WorkflowStep[],
  outputs: Record<string, unknown>,
  targetIndex: number,
  stepIndex: number,
): void {
  for (let index = Math.max(0, targetIndex); index <= stepIndex; index += 1) {
    const step = steps[index];
    if (step?.kind === 'foreach') {
      const prefix = `__foreach:${step.id}:`;
      for (const key of Object.keys(outputs)) {
        if (key.startsWith(prefix)) {
          delete outputs[key];
        }
      }
    }
    if (step?.kind === 'parallel') {
      for (const branch of step.children) {
        for (const branchStep of branch) {
          delete outputs[outputKeyOf(branchStep)];
        }
      }
    }
  }
}
