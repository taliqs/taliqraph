import { outputNameOf } from './output-name-of';
import type { WorkflowInput } from './workflow-definition';
import type { Branch, ConditionBranchStep, WorkflowStep } from './workflow-step';
export type { ReferenceStatus } from './reference-check';
export { checkReference } from './reference-check';

/**
 * The reference scope: what a step at some position may read, as dotted paths.
 * The one model of "who produces what, and when it exists" shared by the linter
 * and the builder's picker. It mirrors the orchestrator's recordOutput calls:
 * every step writes a JSON output under its id (and an agent/script under its
 * `output:` alias too), control steps write what they decided, a condition also
 * writes `.output`, the ran side's headline.
 */
export type ReferenceType = 'number' | 'boolean' | 'string' | 'list' | 'object' | 'unknown';

export interface ReferenceHint {
  readonly path: string;
  readonly type: ReferenceType;
  readonly example?: string;
  /** Where it comes from; shown next to a suggestion. */
  readonly source?: string;
  /** Produced by a step that runs AFTER the reading step; there from a loop's second pass on. */
  readonly later?: boolean;
  /** Written on one side of a condition only - "only when <cond> takes ✓ then". */
  readonly conditional?: string;
  /** A later step nothing loops back from: it can never be available at the reading step. */
  readonly unreachable?: boolean;
}

/** One hop into a lane: which lane of the host ('then' | 'else', or a fork's branch index) and the position in its chain. */
export interface LaneHop {
  readonly lane: 'then' | 'else' | number;
  readonly at: number;
}

/** Where a reference is written: a top-level step, or a chain step inside lanes under it. */
export interface StepAddress {
  readonly index: number;
  readonly path?: readonly LaneHop[];
}

export interface ScopeContext {
  /** The workflow's declared inputs - the `inputs.<name>` root. */
  readonly inputs?: readonly WorkflowInput[];
  /** Agent name -> report skeleton (JSON text): expands an agent's result into typed fields. */
  readonly agentReports?: Readonly<Record<string, string>>;
  /** Script definition name -> report skeleton (JSON text), for `script: <name>` steps. */
  readonly scriptReports?: Readonly<Record<string, string>>;
}

/** The chain a lane of `host` holds; empty for anything that isn't that kind of lane host. */
export function laneChainOf(
  host: WorkflowStep,
  lane: LaneHop['lane'],
): readonly ConditionBranchStep[] {
  if (typeof lane === 'number') {
    return host.kind === 'parallel' ? (host.children[lane] ?? []) : [];
  }
  if (host.kind !== 'condition') {
    return [];
  }
  const side = lane === 'then' ? host.then : host.else;
  return side?.kind === 'steps' ? side.steps : [];
}

/** The lanes a step hosts: a fork's branches, a condition's steps-mode sides. */
export function lanesOf(
  host: WorkflowStep,
): { readonly lane: LaneHop['lane']; readonly chain: readonly ConditionBranchStep[] }[] {
  if (host.kind === 'parallel') {
    return host.children.map((chain, index) => ({ lane: index, chain }));
  }
  if (host.kind === 'condition') {
    return [
      ...(host.then.kind === 'steps' ? [{ lane: 'then' as const, chain: host.then.steps }] : []),
      ...(host.else?.kind === 'steps' ? [{ lane: 'else' as const, chain: host.else.steps }] : []),
    ];
  }
  return [];
}

export interface PipelineJump {
  /** Top-level index the jump fires at (a lane's jump fires at its host's index). */
  readonly from: number;
  /** Top-level index it lands on. */
  readonly to: number;
  /** The step (or lane step) carrying the jump. */
  readonly stepId: string;
}

/**
 * Every jump that moves the pipeline pointer: while / go to / on_blocking, a
 * condition's goto-mode sides, and the same inside lanes when the target is a
 * pipeline step (a lane-internal jump never touches the pipeline pointer).
 */
export function pipelineJumps(steps: readonly WorkflowStep[]): PipelineJump[] {
  const indexOf = (id: string): number => steps.findIndex((entry) => entry.id === id);
  const jumps: PipelineJump[] = [];
  const add = (from: number, stepId: string, targetId: string): void => {
    const to = indexOf(targetId);
    if (to >= 0) {
      jumps.push({ from, to, stepId });
    }
  };
  const visit = (step: WorkflowStep, from: number, inLane: boolean): void => {
    if (step.kind === 'while') add(from, step.id, step.gotoStepId);
    if (step.kind === 'goto') add(from, step.id, step.targetStepId);
    if (step.kind === 'condition') {
      if (step.then.kind === 'goto') add(from, step.id, step.then.stepId);
      if (step.else?.kind === 'goto') add(from, step.id, step.else.stepId);
    }
    // on_blocking inside a lane targets a step of that lane (parser-enforced), not the pipeline
    if (
      !inLane &&
      (step.kind === 'agent' ||
        step.kind === 'workflow' ||
        step.kind === 'parallel' ||
        step.kind === 'foreach') &&
      step.onBlocking
    ) {
      add(from, step.id, step.onBlocking.gotoStepId);
    }
    for (const { chain } of lanesOf(step)) {
      for (const child of chain) {
        visit(child, from, true);
      }
    }
  };
  steps.forEach((step, from) => visit(step, from, false));
  return jumps;
}

/** The jumps that send the pipeline backwards (or re-run the same step). */
export function backwardJumps(steps: readonly WorkflowStep[]): PipelineJump[] {
  return pipelineJumps(steps).filter((jump) => jump.to <= jump.from);
}

/**
 * Later steps whose outputs can already exist when step `current` runs: some
 * jump fires at or after them and lands at or before `current`, so the
 * pipeline comes back through here on a later pass. Maps each to that jump.
 */
export function reachableLaterSteps(
  steps: readonly WorkflowStep[],
  current: number,
): Map<number, PipelineJump> {
  const jumps = backwardJumps(steps);
  const reachable = new Map<number, PipelineJump>();
  for (let later = current + 1; later < steps.length; later += 1) {
    const via = jumps.find((jump) => jump.from >= later && jump.to <= current);
    if (via) {
      reachable.set(later, via);
    }
  }
  return reachable;
}

/**
 * Everything the step at `at` may reference: every top-level step before its
 * host, the earlier steps in each enclosing lane (never a sibling lane), the
 * enclosing conditions' own outputs, later steps a loop brings back (flagged
 * `later`), later steps nothing brings back (flagged `unreachable`, so a typed
 * reference gets a clear error), and run state.
 */
export function referenceScope(
  steps: readonly WorkflowStep[],
  at: StepAddress,
  ctx: ScopeContext = {},
): ReferenceHint[] {
  const collector = createCollector(ctx);
  steps.forEach((step, index) => {
    if (index < at.index) {
      collector.visit(step);
    }
  });
  const host = steps[at.index];
  if (host && at.path && at.path.length > 0) {
    let owner: WorkflowStep | undefined = host;
    for (const hop of at.path) {
      if (!owner) {
        break;
      }
      collector.own(owner); // a condition's own decision is readable inside its lanes
      const chain = laneChainOf(owner, hop.lane);
      for (const earlier of chain.slice(0, hop.at)) {
        collector.visit(earlier);
      }
      owner = chain[hop.at];
    }
  }
  const reachable = reachableLaterSteps(steps, at.index);
  steps.forEach((step, index) => {
    if (index > at.index) {
      if (reachable.has(index)) {
        collector.visit(step, true);
      } else {
        collector.unreachable(step);
      }
    }
  });
  collector.runState(steps);
  return collector.hints;
}

interface Collector {
  readonly hints: ReferenceHint[];
  visit(step: WorkflowStep, later?: boolean): void;
  own(host: WorkflowStep): void;
  unreachable(step: WorkflowStep): void;
  runState(steps: readonly WorkflowStep[]): void;
}

function tagOf(source: string | undefined, later: boolean | undefined): Partial<ReferenceHint> {
  return {
    ...(source ? { source } : {}),
    ...(later ? { later: true } : {}),
  };
}

/** The report skeleton a step's result follows, when its agent / script definition declares one. */
function skeletonOf(ctx: ScopeContext, step: WorkflowStep): string | undefined {
  switch (step.kind) {
    case 'agent':
      return ctx.agentReports?.[step.agent];
    case 'script':
      return ctx.scriptReports?.[step.command];
    default:
      return undefined;
  }
}

/** A skeleton value as typed paths under `prefix`: a list also has `.length`, an object its fields. */
function flattenHints(
  prefix: string,
  value: unknown,
  source: string | undefined,
  later: boolean | undefined,
): ReferenceHint[] {
  const tag = tagOf(source, later);
  if (Array.isArray(value)) {
    return [
      { path: prefix, type: 'list', ...tag },
      { path: `${prefix}.length`, type: 'number', ...tag },
    ];
  }
  if (value !== null && typeof value === 'object') {
    return [
      { path: prefix, type: 'object', ...tag },
      ...Object.entries(value).flatMap(([key, nested]) =>
        flattenHints(`${prefix}.${key}`, nested, source, later),
      ),
    ];
  }
  return [
    { path: prefix, type: scalarTypeOf(value), example: JSON.stringify(value) ?? '', ...tag },
  ];
}

function scalarTypeOf(value: unknown): ReferenceType {
  switch (typeof value) {
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'string':
      return 'string';
    default:
      return 'unknown';
  }
}

/** A result under one root name, expanded through its skeleton when there is one. */
function reportHints(
  root: string,
  skeleton: string | undefined,
  source: string,
  later?: boolean,
): ReferenceHint[] {
  if (!skeleton) {
    return [{ path: root, type: 'unknown', ...tagOf(source, later) }];
  }
  try {
    return flattenHints(root, JSON.parse(skeleton), source, later);
  } catch {
    return [{ path: root, type: 'unknown', ...tagOf(source, later) }];
  }
}

function fieldHint(
  root: string,
  name: string,
  type: ReferenceType,
  example: string | undefined,
  source: string,
  later?: boolean,
): ReferenceHint {
  return {
    path: `${root}.${name}`,
    type,
    ...(example ? { example } : {}),
    ...tagOf(source, later),
  };
}

/** What a control step writes about itself - mirrors WorkflowRun.recordOutput. */
function controlHints(step: WorkflowStep, later?: boolean): ReferenceHint[] {
  const root = step.id;
  switch (step.kind) {
    case 'condition':
      return [
        { path: root, type: 'object', ...tagOf('condition outcome', later) },
        fieldHint(root, 'result', 'boolean', 'true', 'whether the condition held', later),
        fieldHint(root, 'branch', 'string', '"then"', 'which side ran: "then" or "else"', later),
        fieldHint(root, 'value', 'unknown', undefined, 'the value it compared', later),
      ];
    case 'while':
      return [
        { path: root, type: 'object', ...tagOf('loop outcome', later) },
        fieldHint(root, 'looped', 'boolean', 'true', 'whether it looped again', later),
        fieldHint(root, 'iteration', 'number', '2', 'jumps taken so far', later),
        fieldHint(root, 'maxLoops', 'number', undefined, 'its cap', later),
      ];
    case 'goto':
      return [
        { path: root, type: 'object', ...tagOf('jump outcome', later) },
        fieldHint(
          root,
          'jumped',
          'boolean',
          'true',
          'whether it jumped (false once its cap is spent)',
          later,
        ),
        fieldHint(root, 'iteration', 'number', '1', 'jumps taken so far', later),
        fieldHint(root, 'target', 'string', undefined, 'the step it jumps to', later),
      ];
    case 'gate':
      return [
        { path: root, type: 'object', ...tagOf('gate outcome', later) },
        fieldHint(root, 'approved', 'boolean', 'true', 'your decision', later),
        fieldHint(
          root,
          'note',
          'string',
          undefined,
          'the note you typed, empty if you just approved',
          later,
        ),
        fieldHint(root, 'rejections', 'number', '0', 'times sent back so far', later),
        ...(step.choices
          ? [fieldHint(root, 'choice', 'string', step.choices[0]?.id, 'the exit you picked', later)]
          : []),
        ...(step.gate === 'select'
          ? [
              fieldHint(root, 'selected', 'list', undefined, 'the items you ticked', later),
              fieldHint(
                root,
                'dismissed',
                'list',
                undefined,
                'items you dismissed, with reasons',
                later,
              ),
              fieldHint(
                root,
                'includeDetails',
                'boolean',
                'false',
                'carry item details when posting',
                later,
              ),
            ]
          : []),
        ...(step.editable
          ? [
              fieldHint(
                root,
                'edited',
                'object',
                undefined,
                'the shown text as you edited it',
                later,
              ),
            ]
          : []),
      ];
    default:
      return [];
  }
}

/** `<condition>.output`: the ran side's headline (its last step's report), typed from that step's agent skeleton when it has one. */
function headlineHints(
  ctx: ScopeContext,
  condId: string,
  sides: readonly (readonly ConditionBranchStep[])[],
  later?: boolean,
): ReferenceHint[] {
  const root = `${condId}.output`;
  const source = 'whichever side ran - its last step’s report';
  return sides.flatMap((lane): ReferenceHint[] => {
    const last = [...lane]
      .reverse()
      .find((entry) => entry.kind !== 'finish' && entry.kind !== 'fail');
    return last && (last.kind === 'agent' || last.kind === 'script')
      ? reportHints(root, skeletonOf(ctx, last), source, later)
      : [{ path: root, type: 'unknown', ...tagOf(source, later) }];
  });
}

/** Run state: the declared inputs under `inputs.<name>`, and per step what the run tracks about it. */
function runStateHints(ctx: ScopeContext, steps: readonly WorkflowStep[]): ReferenceHint[] {
  const hints: ReferenceHint[] = [];
  if (ctx.inputs && ctx.inputs.length > 0) {
    hints.push({ path: 'inputs', type: 'object', source: 'the declared inputs' });
    for (const input of ctx.inputs) {
      hints.push(...inputHints(input));
    }
  }
  for (const step of steps) {
    if (step.kind === 'gate') {
      hints.push({
        path: `run.gates.${step.id}.approved`,
        type: 'boolean',
        example: 'true',
        source: 'run state',
      });
      hints.push({
        path: `run.rejections.${step.id}`,
        type: 'number',
        example: '1',
        source: 'run state',
      });
    }
    if (step.kind === 'while' || step.kind === 'goto') {
      hints.push({
        path: `run.loops.${step.id}`,
        type: 'number',
        example: '2',
        source: 'run state',
      });
    }
    if (
      (step.kind === 'agent' ||
        step.kind === 'workflow' ||
        step.kind === 'parallel' ||
        step.kind === 'foreach') &&
      step.onBlocking
    ) {
      hints.push({
        path: `run.loops.${step.id}`,
        type: 'number',
        example: '2',
        source: 'run state',
      });
    }
  }
  return hints;
}

/**
 * The walk itself: dedupes paths on first sight and stamps every hint with the
 * conditional side and the unreachable flag in force where it was met.
 */
function createCollector(ctx: ScopeContext): Collector {
  const hints: ReferenceHint[] = [];
  const seen = new Set<string>();
  let conditional: string | undefined;
  let unreachable = false;

  const push = (hint: ReferenceHint): void => {
    if (hint.path.length === 0 || seen.has(hint.path)) {
      return;
    }
    seen.add(hint.path);
    hints.push({
      ...hint,
      ...(conditional ? { conditional: `only when ${conditional}` } : {}),
      ...(unreachable ? { unreachable: true } : {}),
    });
  };
  const pushAll = (batch: readonly ReferenceHint[]): void => {
    batch.forEach(push);
  };
  const withSide = (note: string, body: () => void): void => {
    const outer = conditional;
    conditional = outer ? `${outer} and ${note}` : note;
    body();
    conditional = outer;
  };
  /**
   * A fork's aggregate: `<fork>.<branch>` is the branch's report when the branch
   * is one work step, or its steps' outputs by name when it is a chain. Every
   * inner step is also reachable by its own name (a fork's outputs flat-merge).
   */
  const fork = (prefix: string, children: readonly Branch[], later?: boolean): void => {
    for (const branch of children) {
      const head = branch[0];
      const base = `${prefix}.${head.id}`;
      if (branch.length === 1) {
        if (head.kind === 'agent' || head.kind === 'script') {
          pushAll(
            reportHints(base, skeletonOf(ctx, head), `branch ${head.id} - its report`, later),
          );
        } else if (head.kind === 'parallel') {
          push({
            path: base,
            type: 'object',
            ...tagOf(`branch ${head.id} - a nested fork`, later),
          });
          fork(base, head.children, later);
        } else {
          push({ path: base, type: 'unknown', ...tagOf(`branch ${head.id}`, later) });
        }
      } else {
        push({
          path: base,
          type: 'object',
          ...tagOf(`branch ${head.id} - its steps’ outputs by name`, later),
        });
        for (const inner of branch) {
          const name = `${base}.${outputNameOf(inner)}`;
          if (inner.kind === 'agent' || inner.kind === 'script') {
            pushAll(
              reportHints(name, skeletonOf(ctx, inner), `branch ${head.id} → ${inner.id}`, later),
            );
          } else {
            push({
              path: name,
              type: 'unknown',
              ...tagOf(`branch ${head.id} → ${inner.id}`, later),
            });
          }
        }
      }
      for (const inner of branch) {
        visit(inner, later);
      }
    }
  };
  const visit = (step: WorkflowStep, later?: boolean): void => {
    const id = step.id;
    switch (step.kind) {
      case 'agent': {
        pushAll(reportHints(id, skeletonOf(ctx, step), `${step.agent || 'agent'} report`, later));
        if (step.output && step.output !== id) {
          pushAll(reportHints(step.output, skeletonOf(ctx, step), `alias of ${id}`, later));
        }
        break;
      }
      case 'script': {
        const source = ctx.scriptReports?.[step.command]
          ? `${step.command} report`
          : 'script output (its last JSON line)';
        pushAll(reportHints(id, skeletonOf(ctx, step), source, later));
        if (step.output && step.output !== id) {
          pushAll(reportHints(step.output, skeletonOf(ctx, step), `alias of ${id}`, later));
        }
        break;
      }
      case 'workflow':
        push({
          path: id,
          type: 'object',
          ...tagOf(`${step.workflow || 'sub-workflow'} outputs, by step`, later),
        });
        break;
      case 'parallel':
        push({ path: id, type: 'object', ...tagOf('fork results, by branch', later) });
        fork(id, step.children, later);
        break;
      case 'foreach':
        push({ path: id, type: 'object', ...tagOf('per-item results: "1", "2", …', later) });
        break;
      case 'condition': {
        pushAll(controlHints(step, later));
        const thenSteps = step.then.kind === 'steps' ? step.then.steps : [];
        const elseSteps = step.else?.kind === 'steps' ? step.else.steps : [];
        pushAll(headlineHints(ctx, id, [thenSteps, elseSteps], later));
        // a lane's outputs flat-merge into the pipeline once the sides rejoin, but only the side that ran wrote anything
        withSide(`${id} takes ✓ then`, () => thenSteps.forEach((inner) => visit(inner, later)));
        withSide(`${id} takes ✗ else`, () => elseSteps.forEach((inner) => visit(inner, later)));
        break;
      }
      case 'while':
      case 'goto':
      case 'gate':
        pushAll(controlHints(step, later));
        break;
      case 'finish':
      case 'fail':
        break;
    }
  };
  const own = (host: WorkflowStep): void => {
    if (host.kind === 'condition') {
      pushAll(controlHints(host));
    }
  };
  const unreachableStep = (step: WorkflowStep): void => {
    unreachable = true;
    visit(step, true);
    unreachable = false;
  };
  const runState = (steps: readonly WorkflowStep[]): void => {
    pushAll(runStateHints(ctx, steps));
  };
  return { hints, visit, own, unreachable: unreachableStep, runState };
}

/** The typed fields one declared input contributes. */
export function inputHints(input: WorkflowInput): ReferenceHint[] {
  const root = `inputs.${input.name}`;
  const source = `input${input.required ? '' : ' (optional)'}${input.description ? ` - ${input.description}` : ''}`;
  switch (input.type) {
    case 'number':
      return [{ path: root, type: 'number', example: '3', source }];
    case 'boolean':
      return [{ path: root, type: 'boolean', example: 'true', source }];
    case 'choice':
      return [
        {
          path: root,
          type: 'string',
          example: input.options?.[0] ?? 'a',
          source: `${source} - one of ${(input.options ?? []).join(', ')}`,
        },
      ];
    default:
      return [
        {
          path: root,
          type: 'string',
          example: input.type === 'prompt' ? 'what to do, in your words' : 'text',
          source,
        },
      ];
  }
}
