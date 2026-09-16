import type { ScriptDefinition } from '../script/script-definition';
import { parseMcpName } from './mcp-requirements';
import type { LaneHop, ReferenceHint, ReferenceStatus, ScopeContext } from './reference-scope';
import { checkReference, pipelineJumps, referenceScope } from './reference-scope';
import type { WorkflowDefinition } from './workflow-definition';
import type { ProblemLocation, WorkflowLintResult, WorkflowProblem } from './workflow-problem';
import type { Branch, ConditionBranchStep, WorkflowStep, Comparator } from './workflow-step';

export interface LintContext extends ScopeContext {
  readonly agentNames: readonly string[];
  readonly workflowNames: readonly string[];
  /** The script definitions in scope; when given, `script:` steps are checked against them. */
  readonly scripts?: ReadonlyArray<Pick<ScriptDefinition, 'name' | 'inputs'>>;
  /** Agent name → the MCP servers it lists (tools.mcp); with `mcpServers`, unconfigured ones warn. */
  readonly agentMcp?: ReadonlyMap<string, readonly string[]>;
  /** The MCP servers configured on this machine; undefined = unknown, no check. */
  readonly mcpServers?: readonly string[];
  /** The names inside this workflow's package; when given, a step naming something else warns `package/outside`. */
  readonly insidePackage?: {
    readonly agents: ReadonlySet<string>;
    readonly scripts: ReadonlySet<string>;
    readonly workflows: ReadonlySet<string>;
  };
}

/** What a script definition name looks like: a bare `script: run-tests` that matches none is probably a typo. */
const SCRIPT_NAME_LIKE = /^[a-z][a-z0-9-]*$/;

/** The values a comparator holds a path against; empty for the ones that compare nothing. */
function comparedValues(compare: Comparator): readonly unknown[] {
  if (compare.op === 'in') {
    return Array.isArray(compare.value) ? compare.value : [];
  }
  if (compare.op === 'equals' || compare.op === 'not_equals') {
    return [compare.value];
  }
  return [];
}

/**
 * The workflow linter: everything about a workflow's logic that can be
 * decided before it runs, as structured problems (see WorkflowProblem).
 * Errors are things that can never work: a reference nothing produces or
 * that can never exist yet, an unknown agent / workflow / jump target, an
 * alias that collides with a step id, steps after the run has ended.
 * Warnings work but lossy; infos are worth knowing. The parser still rejects
 * malformed definitions; this runs on what parses.
 *
 * Pure (no IO), so the builder (every edit), task start (errors block) and
 * a CLI `lint` command all use exactly this.
 */
export function lintWorkflow(workflow: WorkflowDefinition, given: LintContext): WorkflowLintResult {
  const ctx: LintContext = { ...given, inputs: workflow.inputs ?? [] };
  const problems: WorkflowProblem[] = [];
  const steps = workflow.steps;
  const indexOf = (stepId: string): number => steps.findIndex((step) => step.id === stepId);
  const topLevelIds = new Set(steps.map((step) => step.id));
  const linter = new StepLinter(workflow, ctx, problems);
  steps.forEach((step, index) => {
    const address = ['steps', index];
    const where = (
      field?: string,
      ref?: string,
      extra?: readonly (string | number)[],
    ): ProblemLocation => ({
      stepId: step.id,
      address: [...address, ...(extra ?? [])],
      ...(field ? { field } : {}),
      ...(ref ? { ref } : {}),
    });
    const scope = (): ReferenceHint[] => referenceScope(steps, { index }, ctx);
    linter.commonChecks(step, where, scope);

    // alias collisions: the two would overwrite each other in the outputs
    if ((step.kind === 'agent' || step.kind === 'script') && step.output) {
      const other = steps.find((candidate) => candidate !== step && candidate.id === step.output);
      if (other) {
        problems.push({
          code: 'output/alias-collision',
          severity: 'error',
          message: `output name '${step.output}' collides with step '${other.id}' - the two would overwrite each other`,
          where: where('output'),
          related: [{ stepId: other.id }],
        });
      }
    }
    if (step.kind === 'while') {
      const target = indexOf(step.gotoStepId);
      if (target < 0) {
        problems.push({
          code: 'jump/unknown-target',
          severity: 'error',
          message: `while loops to unknown step '${step.gotoStepId}'`,
          where: where('goto', step.gotoStepId),
        });
      } else if (target >= index) {
        problems.push({
          code: 'jump/not-backwards',
          severity: 'warning',
          message: `loops "back" to '${step.gotoStepId}', which is not an earlier step`,
          where: where('goto', step.gotoStepId),
          related: [{ stepId: step.gotoStepId }],
        });
      }
    }
    if (step.kind === 'goto' && indexOf(step.targetStepId) < 0) {
      problems.push({
        code: 'jump/unknown-target',
        severity: 'error',
        message: `go to targets unknown step '${step.targetStepId}'`,
        where: where('goto', step.targetStepId),
      });
    }
    if (
      (step.kind === 'agent' ||
        step.kind === 'workflow' ||
        step.kind === 'parallel' ||
        step.kind === 'foreach') &&
      step.onBlocking
    ) {
      const targetId = step.onBlocking.gotoStepId;
      const target = indexOf(targetId);
      if (target < 0) {
        problems.push({
          code: 'jump/unknown-target',
          severity: 'error',
          message: `on_blocking loops to unknown step '${targetId}'`,
          where: where('on_blocking', targetId),
        });
      } else if (target >= index) {
        problems.push({
          code: 'jump/not-backwards',
          severity: 'warning',
          message: `loops "back" to '${targetId}', which is not an earlier step`,
          where: where('on_blocking', targetId),
          related: [{ stepId: targetId }],
        });
      } else {
        const targetStep = steps[target];
        if (targetStep && 'when' in targetStep && targetStep.when && targetStep.when.maxRuns <= 1) {
          problems.push({
            code: 'jump/into-run-once',
            severity: 'warning',
            message: `loops back to '${targetId}', but that step only runs once (when.max_runs) - the loop would skip it`,
            where: where('on_blocking', targetId),
            related: [{ stepId: targetId }],
          });
        }
      }
    }
    if (step.kind === 'condition') {
      for (const [side, branch] of [
        ['then', step.then] as const,
        ...(step.else ? [['else', step.else] as const] : []),
      ]) {
        if (branch.kind === 'goto') {
          if (indexOf(branch.stepId) < 0) {
            problems.push({
              code: 'jump/unknown-target',
              severity: 'error',
              message: `${side} targets unknown step '${branch.stepId}'`,
              where: where(side, branch.stepId),
            });
          }
        } else {
          linter.chain(branch.steps, {
            hostIndex: index,
            hostId: step.id,
            hops: [],
            lane: side,
            address: [...address, side, 'steps'],
            inFork: false,
            enclosingIds: [topLevelIds],
          });
        }
      }
    }
    if (step.kind === 'parallel') {
      step.children.forEach((branch, branchIndex) => {
        linter.chain(branch, {
          hostIndex: index,
          hostId: step.id,
          hops: [],
          lane: branchIndex,
          address: [...address, 'children', branchIndex],
          inFork: true,
          enclosingIds: [topLevelIds],
        });
      });
    }
    if (step.kind === 'foreach') {
      if (!ctx.agentNames.includes(step.template.agent)) {
        problems.push({
          code: 'agent/unknown',
          severity: 'error',
          message: `for_each references agent '${step.template.agent}', which doesn't exist`,
          where: where('agent', undefined, ['template', 'agent']),
        });
      }
      problems.push(
        ...unconfiguredMcp(
          ctx,
          step.template.agent,
          where('agent', undefined, ['template', 'agent']),
        ),
      );
      linter.reference(step.path, scope(), [], where('path', step.path), 'for_each path');
      step.template.input.forEach((ref, position) => {
        linter.reference(
          ref,
          scope(),
          ['all', step.itemName],
          where('input', ref, ['template', 'input', position]),
          'for_each input',
        );
      });
    }
  });

  // Steps after an unconditional finish / fail never run, unless something jumps to them.
  const ended = steps.findIndex((step) => step.kind === 'finish' || step.kind === 'fail');
  if (ended >= 0) {
    const targets = new Set(pipelineJumps(steps).map((jump) => jump.to));
    steps.forEach((step, index) => {
      if (index > ended && !targets.has(index)) {
        const terminal = steps[ended];
        problems.push({
          code: 'flow/dead-steps',
          severity: 'error',
          message: `never runs - the pipeline ends at '${terminal?.id ?? ''}' before it and nothing jumps to it`,
          where: { stepId: step.id, address: ['steps', index] },
          ...(terminal
            ? {
                related: [
                  {
                    stepId: terminal.id,
                    note: terminal.kind === 'finish' ? 'finishes the run' : 'fails the run',
                  },
                ],
              }
            : {}),
        });
      }
    });
  }

  // Declared inputs nobody reads: the form would ask for nothing's sake.
  (workflow.inputs ?? []).forEach((input, position) => {
    if (!linter.usedInputs.has(input.name)) {
      problems.push({
        code: 'input/unused',
        severity: 'warning',
        message: `input '${input.name}' is declared but no step reads inputs.${input.name}`,
        where: {
          stepId: '',
          address: ['inputs', input.name, position],
          field: 'inputs',
          ref: input.name,
        },
      });
    }
  });
  // Declared but never listed by a step: resolved (and possibly prompted for) for nothing.
  (workflow.secrets ?? []).forEach((secret, position) => {
    if (!linter.usedSecrets.has(secret.name)) {
      problems.push({
        code: 'secret/unused',
        severity: 'warning',
        message: `secret '${secret.name}' is declared but no step lists it`,
        where: { stepId: '', address: ['secrets', position], field: 'secrets', ref: secret.name },
      });
    }
  });

  return summarize(problems);
}

function summarize(problems: readonly WorkflowProblem[]): WorkflowLintResult {
  const counts = { error: 0, warning: 0, info: 0 };
  for (const problem of problems) {
    counts[problem.severity] += 1;
  }
  return { ok: counts.error === 0, counts, problems };
}

interface ChainSite {
  readonly hostIndex: number;
  readonly hostId: string;
  /** Hops from the host down to the lane this chain sits in (not including the lane itself). */
  readonly hops: readonly LaneHop[];
  readonly lane: LaneHop['lane'];
  readonly address: readonly (string | number)[];
  /** A fork sits somewhere above: control steps can't live here (the parser refuses them; the builder never offers them). */
  readonly inFork: boolean;
  /** Ids a jump here may target besides this chain's own: the enclosing chains', outermost last. */
  readonly enclosingIds: readonly ReadonlySet<string>[];
}

/** The checks shared by top-level steps and lane steps, plus the lane walk. */
class StepLinter {
  /** Every secret some step listed - the unused check reads it once all steps ran. */
  readonly usedSecrets = new Set<string>();
  /** Every declared input some reference read (`inputs.<name>…`). */
  readonly usedInputs = new Set<string>();

  constructor(
    private readonly workflow: WorkflowDefinition,
    private readonly ctx: LintContext,
    private readonly problems: WorkflowProblem[],
  ) {}

  /** A step's `secrets:` against the workflow's declaration. */
  private checkSecrets(
    step: { readonly secrets?: readonly string[] },
    where: (field?: string, ref?: string, extra?: readonly (string | number)[]) => ProblemLocation,
  ): void {
    const declared = new Set((this.workflow.secrets ?? []).map((secret) => secret.name));
    (step.secrets ?? []).forEach((name, position) => {
      this.usedSecrets.add(name);
      if (!declared.has(name)) {
        this.problems.push({
          code: 'secret/undeclared',
          severity: 'error',
          message: `asks for secret '${name}', which the workflow does not declare`,
          where: where('secrets', name, ['secrets', position]),
          hint: `add it to the workflow's secrets: [${[...declared, name].join(', ')}]`,
        });
      }
    });
  }

  /** `<gate>.choice` compared against an id the gate never offers can only ever be false. */
  private checkChoiceComparison(
    path: string,
    compare: Comparator,
    location: ProblemLocation,
  ): void {
    const match = /^([A-Za-z0-9_-]+).choice$/.exec(path);
    if (!match) {
      return;
    }
    const gate = this.workflow.steps.find((candidate) => candidate.id === match[1]);
    if (gate?.kind !== 'gate' || !gate.choices) {
      return;
    }
    const ids = gate.choices.map((choice) => choice.id);
    for (const value of comparedValues(compare)) {
      if (typeof value === 'string' && !ids.includes(value)) {
        this.problems.push({
          code: 'gate/unknown-choice',
          severity: 'error',
          message: `gate '${gate.id}' has no choice '${value}' - it offers ${ids.join(', ')}`,
          where: location,
        });
      }
    }
  }

  /** One reference in one field: pushes a problem unless the scope says ok. `field` is the human label ('input', 'show', 'path'). */
  reference(
    ref: string,
    scope: readonly ReferenceHint[],
    extras: readonly string[],
    where: ProblemLocation,
    field: string,
  ): void {
    if (ref.startsWith('inputs.')) {
      this.usedInputs.add(ref.split('.')[1] ?? '');
    }
    const status: ReferenceStatus = checkReference(ref, scope, extras);
    if (status.level === 'ok') {
      return;
    }
    this.problems.push({
      code: status.code,
      severity: status.level,
      message: `${field}: ${status.message}`,
      where,
      ...(status.hint ? { hint: status.hint } : {}),
    });
  }

  /** Agent / workflow existence and every reference field; the same for a pipeline step and a lane step. */
  commonChecks(
    step: WorkflowStep,
    where: (field?: string, ref?: string, extra?: readonly (string | number)[]) => ProblemLocation,
    scope: () => readonly ReferenceHint[],
  ): void {
    if (step.kind === 'agent' || step.kind === 'script') {
      this.checkSecrets(step, where);
    }
    if (step.kind === 'finish' || step.kind === 'fail') {
      const hints = scope();
      (step.input ?? []).forEach((ref, position) => {
        this.reference(ref, hints, ['all'], where('input', ref, ['input', position]), 'input');
      });
    }
    if (step.kind === 'agent') {
      if (!this.ctx.agentNames.includes(step.agent)) {
        this.problems.push({
          code: 'agent/unknown',
          severity: 'error',
          message: `references agent '${step.agent}', which doesn't exist`,
          where: where('agent'),
        });
      }
      this.problems.push(...unconfiguredMcp(this.ctx, step.agent, where('agent')));
      this.problems.push(...outsidePackage(this.ctx, 'agent', step.agent, where('agent')));
      const hints = scope();
      step.input.forEach((ref, position) => {
        this.reference(ref, hints, ['all'], where('input', ref, ['input', position]), 'input');
      });
    }
    if (step.kind === 'script') {
      this.problems.push(...outsidePackage(this.ctx, 'script', step.command, where('command')));
      const bound = step.input ?? [];
      const definition = this.ctx.scripts?.find((script) => script.name === step.command);
      if (definition) {
        // inputs are positional: the step's list fills the script's parameters in order
        const required = definition.inputs.filter((input) => input.required).length;
        const slots = definition.inputs
          .map((input) => `${input.name}${input.required ? '' : '?'}`)
          .join(', ');
        if (bound.length < required) {
          this.problems.push({
            code: 'script/missing-input',
            severity: 'error',
            message: `script '${definition.name}' takes ${definition.inputs.length} input${definition.inputs.length === 1 ? '' : 's'} (${slots}) - ${bound.length} given`,
            where: where('input'),
            hint: `input: lists them in that order, e.g. [${definition.inputs.map((input) => `<${input.name}>`).join(', ')}]`,
          });
        } else if (definition.inputs.length > 0 && bound.length > definition.inputs.length) {
          // a script that declares no parameters takes whatever it is given (as `args`)
          this.problems.push({
            code: 'script/extra-input',
            severity: 'warning',
            message: `script '${definition.name}' takes ${definition.inputs.length} input${definition.inputs.length === 1 ? '' : 's'} (${slots}) - ${bound.length} given; the extra ones arrive only in $TQ_INPUTS.args`,
            where: where('input'),
          });
        }
      } else if (this.ctx.scripts && SCRIPT_NAME_LIKE.test(step.command)) {
        this.problems.push({
          code: 'script/unknown',
          severity: 'warning',
          message: `'${step.command}' names no script definition - it runs as a shell command`,
          where: where('script'),
        });
      }
      const hints = scope();
      bound.forEach((ref, position) => {
        this.reference(ref, hints, ['all'], where('input', ref, ['input', position]), 'input');
      });
    }
    if (step.kind === 'gate') {
      const hints = scope();
      step.show.forEach((ref, position) => {
        this.reference(ref, hints, ['diff'], where('show', ref, ['show', position]), 'show');
      });
      if (step.list) {
        this.reference(step.list, hints, [], where('list', step.list), 'list');
        const hint = hints.find((entry) => entry.path === step.list);
        if (hint && hint.type !== 'list' && hint.type !== 'unknown') {
          this.problems.push({
            code: 'gate/list-not-a-list',
            severity: 'warning',
            message: `list '${step.list}' is ${hint.type}, not a list - the gate would have nothing to tick`,
            where: where('list', step.list),
          });
        }
      }
      const seen = new Set<string>();
      (step.choices ?? []).forEach((choice, position) => {
        if (seen.has(choice.id)) {
          this.problems.push({
            code: 'gate/duplicate-choice',
            severity: 'error',
            message: `two choices are called '${choice.id}'`,
            where: where('choices', choice.id, ['choices', position]),
          });
        }
        seen.add(choice.id);
      });
    }
    if (step.kind === 'condition' || step.kind === 'while') {
      this.reference(step.path, scope(), [], where('path', step.path), 'path');
      this.checkChoiceComparison(step.path, step.compare, where('path', step.path));
    }
    if (step.kind === 'workflow') {
      this.problems.push(...outsidePackage(this.ctx, 'workflow', step.workflow, where('workflow')));
      if (step.workflow === this.workflow.name) {
        this.problems.push({
          code: 'workflow/self-nesting',
          severity: 'error',
          message: 'nests this workflow inside itself',
          where: where('workflow'),
        });
      } else if (!this.ctx.workflowNames.includes(step.workflow)) {
        this.problems.push({
          code: 'workflow/unknown',
          severity: 'error',
          message: `references workflow '${step.workflow}', which doesn't exist`,
          where: where('workflow'),
        });
      }
    }
  }

  /** One lane (a fork branch or a condition side), recursing into anything that forks again. */
  chain(chain: readonly ConditionBranchStep[] | Branch, site: ChainSite): void {
    const ownIds = new Set(chain.map((step) => step.id));
    const enclosingIds = [ownIds, ...site.enclosingIds];
    const mayTarget = (id: string): boolean => enclosingIds.some((ids) => ids.has(id));
    chain.forEach((step, position) => {
      const hops: LaneHop[] = [...site.hops, { lane: site.lane, at: position }];
      const address = [...site.address, position];
      const where = (
        field?: string,
        ref?: string,
        extra?: readonly (string | number)[],
      ): ProblemLocation => ({
        stepId: site.hostId,
        innerStepId: step.id,
        address: [...address, ...(extra ?? [])],
        ...(field ? { field } : {}),
        ...(ref ? { ref } : {}),
      });
      const scope = (): ReferenceHint[] =>
        referenceScope(this.workflow.steps, { index: site.hostIndex, path: hops }, this.ctx);
      this.commonChecks(step, where, scope);

      const jumpTarget = (label: string, field: string, targetId: string): void => {
        if (!mayTarget(targetId)) {
          this.problems.push({
            code: 'jump/unknown-target',
            severity: 'error',
            message: `${label} targets '${targetId}', which is neither in this lane, an enclosing one, nor the pipeline`,
            where: where(field, targetId),
          });
        }
      };
      if (step.kind === 'goto') {
        jumpTarget('go to', 'goto', step.targetStepId);
      }
      if (step.kind === 'while') {
        if (!ownIds.has(step.gotoStepId)) {
          this.problems.push({
            code: 'jump/unknown-target',
            severity: 'error',
            message: `while loops to '${step.gotoStepId}', which is not a step of this lane`,
            where: where('goto', step.gotoStepId),
          });
        }
      }
      if ((step.kind === 'agent' || step.kind === 'workflow') && step.onBlocking) {
        if (chain.length === 1 && site.inFork) {
          this.problems.push({
            code: 'fork/on-blocking-ignored',
            severity: 'warning',
            message:
              'has on_blocking, which is ignored on a single-step branch (nothing earlier in the branch to loop back to)',
            where: where('on_blocking'),
          });
        } else if (!ownIds.has(step.onBlocking.gotoStepId)) {
          this.problems.push({
            code: 'jump/unknown-target',
            severity: 'error',
            message: `on_blocking loops to '${step.onBlocking.gotoStepId}', which is not a step of this lane`,
            where: where('on_blocking', step.onBlocking.gotoStepId),
          });
        }
      }
      if (step.kind === 'condition') {
        for (const [side, branch] of [
          ['then', step.then] as const,
          ...(step.else ? [['else', step.else] as const] : []),
        ]) {
          if (branch.kind === 'goto') {
            jumpTarget(side, side, branch.stepId);
          } else {
            this.chain(branch.steps, {
              hostIndex: site.hostIndex,
              hostId: site.hostId,
              hops,
              lane: side,
              address: [...address, side, 'steps'],
              inFork: site.inFork,
              enclosingIds,
            });
          }
        }
      }
      if (step.kind === 'parallel') {
        step.children.forEach((branch, branchIndex) => {
          this.chain(branch, {
            hostIndex: site.hostIndex,
            hostId: site.hostId,
            hops,
            lane: branchIndex,
            address: [...address, 'children', branchIndex],
            inFork: true,
            enclosingIds,
          });
        });
      }
      // an alias colliding with a pipeline step id would overwrite it once the lane merges
      if ((step.kind === 'agent' || step.kind === 'script') && step.output) {
        const alias = step.output;
        const clash =
          this.workflow.steps.find((candidate) => candidate.id === alias) ??
          chain.find((candidate) => candidate !== step && candidate.id === alias);
        if (clash) {
          this.problems.push({
            code: 'output/alias-collision',
            severity: 'error',
            message: `output name '${alias}' collides with step '${clash.id}' - the two would overwrite each other`,
            where: where('output'),
            related: [{ stepId: clash.id }],
          });
        }
      }
    });
  }
}

/** A warning per MCP server the agent lists that this machine has not configured (optional `name?` ones excepted). */
function unconfiguredMcp(
  ctx: LintContext,
  agentName: string,
  where: WorkflowProblem['where'],
): WorkflowProblem[] {
  if (!ctx.mcpServers || !ctx.agentMcp) {
    return [];
  }
  const configured = ctx.mcpServers;
  return (ctx.agentMcp.get(agentName) ?? []).flatMap((raw) => {
    const { name, optional } = parseMcpName(raw);
    if (optional || configured.includes(name)) {
      return [];
    }
    return [
      {
        code: 'mcp/unconfigured' as const,
        severity: 'warning' as const,
        message: `agent '${agentName}' uses MCP server '${name}', which was not offered to this run - offer it, or mark it optional (${name}?)`,
        where,
      },
    ];
  });
}

/** A warning when the step names something the package does not carry (a loose piece or a sibling package's member). */
function outsidePackage(
  ctx: LintContext,
  kind: 'agent' | 'script' | 'workflow',
  name: string,
  where: WorkflowProblem['where'],
): WorkflowProblem[] {
  const inside = ctx.insidePackage;
  if (!inside) {
    return [];
  }
  const known = knownInScope(ctx, kind, name);
  const carried = carriedByPackage(inside, kind, name);
  if (!known || carried) {
    return [];
  }
  return [
    {
      code: 'package/outside' as const,
      severity: 'warning' as const,
      message: `${kind} '${name}' lives outside this workflow's package - it runs here through the shelf or a sibling package, but would be missing anywhere the package is copied to; Export copies it in`,
      where,
    },
  ];
}

function knownInScope(
  ctx: LintContext,
  kind: 'agent' | 'script' | 'workflow',
  name: string,
): boolean {
  switch (kind) {
    case 'agent':
      return ctx.agentNames.includes(name);
    case 'script':
      return (ctx.scripts ?? []).some((script) => script.name === name);
    case 'workflow':
      return ctx.workflowNames.includes(name);
  }
}

function carriedByPackage(
  inside: NonNullable<LintContext['insidePackage']>,
  kind: 'agent' | 'script' | 'workflow',
  name: string,
): boolean {
  switch (kind) {
    case 'agent':
      return inside.agents.has(name);
    case 'script':
      return inside.scripts.has(name);
    case 'workflow':
      return inside.workflows.has(name);
  }
}
