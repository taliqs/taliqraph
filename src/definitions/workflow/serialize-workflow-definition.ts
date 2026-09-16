import { stringify as stringifyYaml } from 'yaml';
import type { WorkflowDefinition, WorkflowInput } from './workflow-definition';
import type { ConditionBranch, WorkflowStep } from './workflow-step';

/**
 * Renders a WorkflowDefinition back into its on-disk `workflow.yaml` form,
 * the inverse of parseWorkflowDefinition. Scope is implied by file location.
 * Structured saves normalize formatting; hand-written comments do not survive.
 */
export function serializeWorkflowDefinition(workflow: WorkflowDefinition): string {
  const doc: Record<string, unknown> = {
    name: workflow.name,
    title: workflow.title,
    ...(workflow.description ? { description: workflow.description } : {}),
    ...(workflow.extendsName ? { extends: workflow.extendsName } : {}),
    ...(workflow.inputs && workflow.inputs.length > 0
      ? { inputs: inputsToMapping(workflow.inputs) }
      : {}),
    ...(workflow.secrets && workflow.secrets.length > 0
      ? { secrets: workflow.secrets.map((secret) => `${secret.name}${secret.required ? '' : '?'}`) }
      : {}),
    ...(workflow.env && workflow.env.length > 0 ? { env: [...workflow.env] } : {}),
    steps: workflow.steps.map(stepToYaml),
  };
  return stringifyYaml(doc, { lineWidth: 0 });
}

function stepToYaml(step: WorkflowStep): Record<string, unknown> {
  switch (step.kind) {
    case 'agent':
      return {
        id: step.id,
        agent: step.agent,
        ...(step.model ? { model: step.model } : {}),
        ...(step.effort ? { effort: step.effort } : {}),
        ...(step.input.length > 0 ? { input: [...step.input] } : {}),
        ...(step.output ? { output: step.output } : {}),
        ...onBlockingToYaml(step.onBlocking),
        ...(step.secrets && step.secrets.length > 0 ? { secrets: [...step.secrets] } : {}),
        ...whenToYaml(step.when),
      };
    case 'gate':
      return {
        id: step.id,
        gate: step.gate,
        ...(step.show.length > 0 ? { show: [...step.show] } : {}),
        ...(step.editable ? { editable: true } : {}),
        ...(step.list ? { list: step.list } : {}),
        ...(step.choices
          ? {
              choices: step.choices.map((choice) => ({
                id: choice.id,
                label: choice.label,
                ...(choice.needs === 'none' ? { needs: 'none' } : {}),
                ...(choice.default ? { default: true } : {}),
              })),
            }
          : {}),
      };
    case 'workflow':
      return {
        id: step.id,
        workflow: step.workflow,
        ...onBlockingToYaml(step.onBlocking),
        ...whenToYaml(step.when),
      };
    case 'script':
      return {
        id: step.id,
        script: step.command,
        ...(step.input && step.input.length > 0 ? { input: [...step.input] } : {}),
        ...(step.params && Object.keys(step.params).length > 0 ? { with: { ...step.params } } : {}),
        ...(step.output ? { output: step.output } : {}),
        ...(step.secrets && step.secrets.length > 0 ? { secrets: [...step.secrets] } : {}),
        ...whenToYaml(step.when),
      };
    case 'condition':
      return {
        id: step.id,
        if: step.path,
        ...comparatorToYaml(step.compare),
        ...branchToYaml('then', step.then),
        ...(step.else ? branchToYaml('else', step.else) : {}),
      };
    case 'while':
      return {
        id: step.id,
        while: step.path,
        ...comparatorToYaml(step.compare),
        goto: step.gotoStepId,
        max_loops: step.maxLoops,
      };
    case 'foreach': {
      const template = stepToYaml(step.template) as Record<string, unknown>;
      delete template.id; // implicit: clones are numbered per item at run time
      return {
        id: step.id,
        for_each: step.path,
        ...(step.itemName !== 'item' ? { as: step.itemName } : {}),
        ...(step.maxItems !== 10 ? { max_items: step.maxItems } : {}),
        ...(step.onFail && step.onFail !== 'fail' ? { on_fail: step.onFail } : {}),
        ...onBlockingToYaml(step.onBlocking),
        do: template,
      };
    }
    case 'parallel':
      return {
        id: step.id,
        ...(step.onFail && step.onFail !== 'fail' ? { on_fail: step.onFail } : {}),
        ...onBlockingToYaml(step.onBlocking),
        parallel: step.children.map((branch) => branch.map((child) => stepToYaml(child))),
      };
    case 'goto':
      return { id: step.id, goto: step.targetStepId, max_loops: step.maxLoops };
    case 'finish':
      return {
        id: step.id,
        finish: 'run',
        ...(step.input && step.input.length > 0 ? { input: [...step.input] } : {}),
        ...(step.params && Object.keys(step.params).length > 0 ? { with: { ...step.params } } : {}),
      };
    case 'fail':
      return {
        id: step.id,
        fail: step.message,
        ...(step.input && step.input.length > 0 ? { input: [...step.input] } : {}),
        ...(step.params && Object.keys(step.params).length > 0 ? { with: { ...step.params } } : {}),
      };
  }
}

function branchToYaml(key: 'then' | 'else', branch: ConditionBranch): Record<string, unknown> {
  if (branch.kind === 'goto') {
    return { [key]: branch.stepId };
  }
  return { [key]: branch.steps.map((child) => stepToYaml(child)) };
}

function comparatorToYaml(compare: { op: string; value?: unknown }): Record<string, unknown> {
  return compare.op === 'truthy' ? {} : { [compare.op]: compare.value };
}

function onBlockingToYaml(
  policy: { gotoStepId: string; maxLoops: number; then: 'gate' | 'fail' } | undefined,
): Record<string, unknown> {
  return policy
    ? { on_blocking: { goto: policy.gotoStepId, max_loops: policy.maxLoops, then: policy.then } }
    : {};
}

function whenToYaml(when: { maxRuns: number } | undefined): Record<string, unknown> {
  return when ? { when: { max_runs: when.maxRuns } } : {};
}

/** The declarations as the `inputs:` mapping: one spec per name, the shape the builder edits as JSON. */
export function inputsToMapping(inputs: readonly WorkflowInput[]): Record<string, unknown> {
  return Object.fromEntries(
    inputs.map((input) => [
      input.name,
      {
        type: input.type,
        ...(input.required ? {} : { required: false }),
        ...(input.description ? { description: input.description } : {}),
        ...(input.default !== undefined ? { default: input.default } : {}),
        ...(input.options ? { options: [...input.options] } : {}),
      },
    ]),
  );
}
