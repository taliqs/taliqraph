import type { ConditionBranch, WorkflowStep } from '../../definitions/workflow/workflow-step';
import type { WorkflowDefinition } from '../../definitions/workflow/workflow-definition';

/** `workflows show <name>`: the pipeline as an indented step list. */
export function renderWorkflow(workflow: WorkflowDefinition): string[] {
  return [
    `${workflow.name} - ${workflow.title}`,
    ...(workflow.description ? [workflow.description] : []),
    ...(workflow.inputs?.length
      ? [
          `inputs: ${workflow.inputs
            .map((input) => `${input.name}: ${input.type}${input.required ? '' : '?'}`)
            .join(', ')}`,
        ]
      : []),
    '',
    ...workflow.steps.flatMap((step) => renderStep(step, 0)),
  ];
}

function renderStep(step: WorkflowStep, depth: number): string[] {
  const pad = '  '.repeat(depth);
  const lane = (label: string, steps: readonly WorkflowStep[]): string[] => [
    `${pad}  ${label}`,
    ...steps.flatMap((inner) => renderStep(inner, depth + 2)),
  ];
  const branch = (label: string, value: ConditionBranch): string[] =>
    value.kind === 'goto' ? [`${pad}  ${label} → ${value.stepId}`] : lane(`${label}:`, value.steps);
  const io = (input: readonly string[] | undefined, output: string | undefined): string =>
    `${input?.length ? ` ← ${input.join(', ')}` : ''}${output ? ` → ${output}` : ''}`;
  switch (step.kind) {
    case 'agent':
      return [`${pad}${step.id}  agent ${step.agent}${io(step.input, step.output)}`];
    case 'script':
      return [`${pad}${step.id}  script ${step.command}${io(step.input, step.output)}`];
    case 'workflow':
      return [`${pad}${step.id}  workflow ${step.workflow}`];
    case 'gate':
      return [
        `${pad}${step.id}  gate${step.show.length ? ` - shows ${step.show.join(', ')}` : ''}${step.editable ? ', editable' : ''}`,
      ];
    case 'condition':
      return [
        `${pad}${step.id}  if ${step.path} ${JSON.stringify(step.compare)}`,
        ...branch('then', step.then),
        ...(step.else ? branch('else', step.else) : []),
      ];
    case 'while':
      return [
        `${pad}${step.id}  while ${step.path} ${JSON.stringify(step.compare)} → ${step.gotoStepId} (max ${step.maxLoops})`,
      ];
    case 'parallel':
      return [
        `${pad}${step.id}  parallel ×${step.children.length}`,
        ...step.children.flatMap((children, index) => lane(`lane ${index + 1}`, children)),
      ];
    case 'foreach':
      return [
        `${pad}${step.id}  for each ${step.itemName} in ${step.path} (max ${step.maxItems})`,
        ...renderStep(step.template, depth + 2),
      ];
    default:
      return [`${pad}${step.id}  ${step.kind}`];
  }
}
