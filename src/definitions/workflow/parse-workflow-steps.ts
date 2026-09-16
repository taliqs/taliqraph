import type { z } from 'zod';
import { formatZodIssues } from '../format-zod-issues';
import type { onBlockingSchema } from './workflow-schema';
import {
  STEP_DISCRIMINATORS,
  agentStepSchema,
  conditionStepSchema,
  failStepSchema,
  finishStepSchema,
  forEachStepSchema,
  gateStepSchema,
  gotoStepSchema,
  parallelStepSchema,
  scriptStepSchema,
  subWorkflowStepSchema,
  whileStepSchema,
} from './workflow-schema';
import type {
  Branch,
  BranchStep,
  Comparator,
  ConditionBranch,
  ConditionBranchStep,
  OnBlockingPolicy,
  WorkflowStep,
} from './workflow-step';

const FLOW_KINDS: ReadonlySet<WorkflowStep['kind']> = new Set(['goto', 'finish', 'fail']);

/** A fork branch holds work steps only; parseBranchStep has already rejected the rest. */
function isForkStep(step: ConditionBranchStep): step is BranchStep {
  return step.kind !== 'gate' && !FLOW_KINDS.has(step.kind);
}

function comparatorOf(data: {
  equals?: unknown;
  not_equals?: unknown;
  gte?: number;
  lte?: number;
  in?: readonly unknown[];
}): Comparator {
  if (data.equals !== undefined) {
    return { op: 'equals', value: data.equals };
  }
  if (data.not_equals !== undefined) {
    return { op: 'not_equals', value: data.not_equals };
  }
  if (data.gte !== undefined) {
    return { op: 'gte', value: data.gte };
  }
  if (data.lte !== undefined) {
    return { op: 'lte', value: data.lte };
  }
  if (data.in !== undefined) {
    return { op: 'in', value: [...data.in] };
  }
  return { op: 'truthy' };
}

/** The `on_blocking:` mapping as the step carries it; nothing when the step has none. */
function onBlockingFromYaml(
  policy: z.infer<typeof onBlockingSchema> | undefined,
): { readonly onBlocking: OnBlockingPolicy } | Record<never, never> {
  return policy
    ? { onBlocking: { gotoStepId: policy.goto, maxLoops: policy.max_loops, then: policy.then } }
    : {};
}

/** `inFork`: this step sits somewhere under a parallel branch - its lanes can't hold gates either. */
export function parseStep(
  rawStep: Record<string, unknown>,
  index: number,
  issues: string[],
  inFork = false,
): WorkflowStep | null {
  const at = `steps[${index}]`;

  // `goto:` is a while step's loop target as well as the jump step's own key
  const discriminators = STEP_DISCRIMINATORS.filter(
    (key) => key in rawStep && !(key === 'goto' && 'while' in rawStep),
  );
  if (discriminators.length === 0) {
    issues.push(`${at}: step must contain one of: ${STEP_DISCRIMINATORS.join(', ')}`);
    return null;
  }
  if (discriminators.length > 1) {
    issues.push(`${at}: step mixes multiple kinds (${discriminators.join(', ')})`);
    return null;
  }

  const kind = discriminators[0];
  switch (kind) {
    case 'agent': {
      const result = agentStepSchema.safeParse(rawStep);
      if (!result.success) {
        issues.push(...prefixIssues(at, result.error));
        return null;
      }
      const {
        model,
        effort,
        output,
        on_blocking: onBlocking,
        secrets,
        when,
        ...rest
      } = result.data;
      return {
        kind: 'agent',
        id: rest.id,
        agent: rest.agent,
        input: rest.input,
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
        ...(output ? { output } : {}),
        ...(secrets && secrets.length > 0 ? { secrets } : {}),
        ...onBlockingFromYaml(onBlocking),
        ...(when ? { when: { maxRuns: when.max_runs } } : {}),
      };
    }
    case 'script': {
      const result = scriptStepSchema.safeParse(rawStep);
      if (!result.success) {
        issues.push(...prefixIssues(at, result.error));
        return null;
      }
      return {
        kind: 'script',
        id: result.data.id,
        command: result.data.script,
        ...(result.data.input && result.data.input.length > 0 ? { input: result.data.input } : {}),
        ...(result.data.with && Object.keys(result.data.with).length > 0
          ? { params: result.data.with }
          : {}),
        ...(result.data.output ? { output: result.data.output } : {}),
        ...(result.data.secrets && result.data.secrets.length > 0
          ? { secrets: result.data.secrets }
          : {}),
        ...(result.data.when ? { when: { maxRuns: result.data.when.max_runs } } : {}),
      };
    }
    case 'gate': {
      const result = gateStepSchema.safeParse(rawStep);
      if (!result.success) {
        issues.push(...prefixIssues(at, result.error));
        return null;
      }
      if ((result.data.choices ?? []).filter((choice) => choice.default).length > 1) {
        issues.push(`${at}: only one choice can be the default (the exit a headless run takes)`);
        return null;
      }
      const gateProblem = gateShapeProblem(result.data);
      if (gateProblem) {
        issues.push(`${at}: ${gateProblem}`);
        return null;
      }
      return {
        kind: 'gate',
        id: result.data.id,
        gate: result.data.gate,
        show: result.data.show,
        editable: result.data.editable,
        ...(result.data.list ? { list: result.data.list } : {}),
        ...(result.data.choices
          ? {
              choices: result.data.choices.map((choice) => ({
                id: choice.id,
                label: choice.label,
                needs: choice.needs ?? 'selection',
                ...(choice.default ? { default: true } : {}),
              })),
            }
          : {}),
      };
    }
    case 'workflow': {
      const result = subWorkflowStepSchema.safeParse(rawStep);
      if (!result.success) {
        issues.push(...prefixIssues(at, result.error));
        return null;
      }
      return {
        kind: 'workflow',
        id: result.data.id,
        workflow: result.data.workflow,
        ...onBlockingFromYaml(result.data.on_blocking),
        ...(result.data.when ? { when: { maxRuns: result.data.when.max_runs } } : {}),
      };
    }
    case 'if': {
      const result = conditionStepSchema.safeParse(rawStep);
      if (!result.success) {
        issues.push(...prefixIssues(at, result.error));
        return null;
      }
      const then = parseConditionBranch(result.data.then, `${at}.then`, issues, inFork) ?? {
        kind: 'steps' as const,
        steps: [],
      };
      const elseBranch =
        result.data.else !== undefined
          ? parseConditionBranch(result.data.else, `${at}.else`, issues, inFork)
          : undefined;
      return {
        kind: 'condition',
        id: result.data.id,
        path: result.data.if,
        compare: comparatorOf(result.data),
        then,
        ...(elseBranch ? { else: elseBranch } : {}),
      };
    }
    case 'while': {
      const result = whileStepSchema.safeParse(rawStep);
      if (!result.success) {
        issues.push(...prefixIssues(at, result.error));
        return null;
      }
      return {
        kind: 'while',
        id: result.data.id,
        path: result.data.while,
        compare: comparatorOf(result.data),
        gotoStepId: result.data.goto,
        maxLoops: result.data.max_loops,
      };
    }
    case 'parallel': {
      const result = parallelStepSchema.safeParse(rawStep);
      if (!result.success) {
        issues.push(...prefixIssues(at, result.error));
        return null;
      }
      const children: Branch[] = [];
      result.data.parallel.forEach((rawBranch, branchIndex) => {
        const rawSteps = Array.isArray(rawBranch) ? rawBranch : [rawBranch];
        const steps = parseBranchSteps(rawSteps, `${at}.parallel[${branchIndex}]`, issues, true);
        const [first, ...rest] = steps.filter(isForkStep);
        if (!first) {
          return; // every step in this branch failed to parse or was rejected; already logged
        }
        children.push([first, ...rest]);
      });
      if (children.length < 2) {
        return null;
      }
      return {
        kind: 'parallel',
        id: result.data.id,
        children,
        ...(result.data.on_fail && result.data.on_fail !== 'fail'
          ? { onFail: result.data.on_fail }
          : {}),
        ...onBlockingFromYaml(result.data.on_blocking),
      };
    }
    case 'for_each': {
      const result = forEachStepSchema.safeParse(rawStep);
      if (!result.success) {
        issues.push(...prefixIssues(at, result.error));
        return null;
      }
      const rawTemplate = { id: 'item', ...result.data.do };
      const template = parseStep(rawTemplate, 0, issues);
      if (!template) {
        return null;
      }
      if (template.kind !== 'agent') {
        issues.push(`${at}.do: for_each runs an agent per item - got '${template.kind}'`);
        return null;
      }
      return {
        kind: 'foreach',
        id: result.data.id,
        path: result.data.for_each,
        itemName: result.data.as ?? 'item',
        maxItems: result.data.max_items ?? 10,
        template,
        ...(result.data.on_fail && result.data.on_fail !== 'fail'
          ? { onFail: result.data.on_fail }
          : {}),
        ...onBlockingFromYaml(result.data.on_blocking),
      };
    }
    case 'goto': {
      const result = gotoStepSchema.safeParse(rawStep);
      if (!result.success) {
        issues.push(...prefixIssues(at, result.error));
        return null;
      }
      return {
        kind: 'goto',
        id: result.data.id,
        targetStepId: result.data.goto,
        maxLoops: result.data.max_loops,
      };
    }
    case 'finish': {
      const result = finishStepSchema.safeParse(rawStep);
      if (!result.success) {
        issues.push(...prefixIssues(at, result.error));
        return null;
      }
      return {
        kind: 'finish',
        id: result.data.id,
        ...(result.data.input && result.data.input.length > 0 ? { input: result.data.input } : {}),
        ...(result.data.with && Object.keys(result.data.with).length > 0
          ? { params: result.data.with }
          : {}),
      };
    }
    case 'fail': {
      const result = failStepSchema.safeParse(rawStep);
      if (!result.success) {
        issues.push(...prefixIssues(at, result.error));
        return null;
      }
      return {
        kind: 'fail',
        id: result.data.id,
        message: result.data.fail,
        ...(result.data.input && result.data.input.length > 0 ? { input: result.data.input } : {}),
        ...(result.data.with && Object.keys(result.data.with).length > 0
          ? { params: result.data.with }
          : {}),
      };
    }
    default:
      issues.push(`${at}: unknown step kind`);
      return null;
  }
}

/**
 * A step kind allowed inside a branch - everything a top-level step can be
 * except for_each and, anywhere under a fork, the steps that steer the
 * pipeline itself (gate, goto, finish, fail): with sibling branches
 * mid-flight there is nothing coherent for them to pause, jump or end. A
 * condition's own lane takes them - only one side runs.
 */
function parseBranchStep(
  rawStep: Record<string, unknown>,
  at: string,
  index: number,
  issues: string[],
  inFork: boolean,
): ConditionBranchStep | null {
  const step = parseStep(rawStep, index, issues, inFork);
  if (!step) {
    return null;
  }
  if (step.kind === 'gate' && inFork) {
    issues.push(
      `${at}[${index}]: a gate can't run inside a branch - approvals pause the whole pipeline while sibling branches are mid-flight`,
    );
    return null;
  }
  if (FLOW_KINDS.has(step.kind) && inFork) {
    issues.push(
      `${at}[${index}]: a ${step.kind} step can't run inside a parallel branch - sibling branches are mid-flight`,
    );
    return null;
  }
  if (step.kind === 'foreach') {
    issues.push(`${at}[${index}]: for_each can't nest inside a branch`);
    return null;
  }
  return step;
}

/** Parses every step of a branch; may return an empty array (a condition's steps-branch allows it). */
function parseBranchSteps(
  rawSteps: readonly Record<string, unknown>[],
  at: string,
  issues: string[],
  inFork: boolean,
): ConditionBranchStep[] {
  const steps: ConditionBranchStep[] = [];
  rawSteps.forEach((rawStep, index) => {
    const step = parseBranchStep(rawStep, at, index, issues, inFork);
    if (step) {
      steps.push(step);
    }
  });
  return steps;
}

function parseConditionBranch(
  raw: string | Record<string, unknown>[] | undefined,
  at: string,
  issues: string[],
  inFork: boolean,
): ConditionBranch | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw === 'string') {
    return { kind: 'goto', stepId: raw };
  }
  return { kind: 'steps', steps: parseBranchSteps(raw, at, issues, inFork) };
}

function prefixIssues(at: string, error: z.ZodError): string[] {
  return formatZodIssues(error).map((issue) => `${at}: ${issue}`);
}

/** Each gate kind takes its own fields; anything else is a mistake worth naming. */
function gateShapeProblem(gate: {
  gate: 'approve' | 'choice' | 'select';
  list?: string;
  choices?: readonly unknown[];
}): string | null {
  const hasChoices = (gate.choices ?? []).length > 0;
  if (gate.gate === 'approve') {
    if (hasChoices) {
      return 'gate: approve answers yes or no - use gate: choice for named exits';
    }
    return gate.list ? 'gate: approve has nothing to tick - use gate: select for a list' : null;
  }
  if (gate.gate === 'choice') {
    if (!hasChoices) {
      return 'gate: choice needs choices - the exits to pick from';
    }
    return gate.list ? 'gate: choice picks one exit - use gate: select to tick a list' : null;
  }
  return gate.list ? null : 'gate: select needs list - the reference whose array is ticked';
}
