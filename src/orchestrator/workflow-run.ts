import type { AgentDefinition } from '../definitions/agent/agent-definition';
import type {
  AgentStep,
  Comparator,
  ConditionBranchStep,
  ConditionStep,
  FailStep,
  FinishStep,
  OnBlockingPolicy,
  SubWorkflowStep,
  WorkflowStep,
} from '../definitions/workflow/workflow-step';
import type { ScriptDefinition } from '../definitions/script/script-definition';
import type { WorkflowDefinition } from '../definitions/workflow/workflow-definition';
import type { EffortLevel } from '../shared/types/effort';
import type { EngineEvent } from '../engines/engine-event';
import type { EngineRegistry } from '../engines/engine-registry';
import type { EngineSession, McpServerSpec } from '../engines/engine-adapter';
import { runAgentStep } from './agent-step';
import { clearForkMemos, laneHeadline, outputKeyOf, recordOutput } from './output-keys';
import { readOutputPath } from './read-output-path';
import type { GateAnswer, GateItem, GateSelection, RunEvent, RunStatus } from './run-event';
import { BUDGET_GATE_ID, isTerminal } from './run-event';
import {
  MAX_NESTING_DEPTH,
  branchReport,
  handleForkBlocking,
  isBlockingReport,
  resolveSubWorkflow,
  runBranchChain,
  runForEach,
  runParallel,
} from './run-fanout';
import { headlessAnswer, openGate, resolveGate, updateGateSelection } from './run-gates';
import { restoreRun, scopeChildEvent, unscopeChildEvents } from './run-resume';
import { capText, runScriptStep } from './script-step';

/** Why a run stopped without failing: a usage limit that lifts, or a login the user has to renew. */
type InterruptCause = 'quota' | 'auth';

export interface TaskRunContext {
  readonly taskId: string;
  readonly projectId: string;
  readonly workspacePath: string;
  /** True when the workspace is a copy the host made for this run, not the folder itself. */
  readonly isolated?: boolean;
  /** False turns off live typing: no `agent-text-partial`, the finished text unchanged. */
  readonly streamText?: boolean;
  /** The declared inputs, resolved - steps read them as `inputs.<name>`. */
  readonly inputs: Readonly<Record<string, unknown>>;
  /**
   * The workflow's declared secrets, resolved: name → value. Bound into a
   * step's environment only when the step lists the name - never into inputs,
   * outputs or the prompt.
   */
  readonly secrets?: Readonly<Record<string, string>>;
  /**
   * The clean base environment plus the workflow's `env:` pass-through,
   * built by the runtime. When set, every step process starts from exactly
   * this (plus its own secrets); absent = steps inherit the host's environment.
   */
  readonly env?: Readonly<Record<string, string>>;
}

export interface StepMeta {
  readonly stepId: string;
  readonly agentName: string;
  readonly engineId: string;
  readonly model: string;
  readonly effort?: EffortLevel;
}

export interface ScriptResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /** What the script wrote to `$TQ_REPORT_FILE`, when it did - wins over stdout. */
  readonly report?: unknown;
}

/** One script execution: a definition (spawned without a shell) or an inline command line (through the shell). */
export interface ScriptRunSpec {
  readonly command?: string;
  readonly definition?: ScriptDefinition;
  /** The step's inputs, resolved (see collectStepInputs): `task`, `args` in order, each value under its parameter or reference name. */
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly timeoutMs: number;
  /** The process environment: clean base + pass-through + this step's secrets. Absent = the host's. */
  readonly env?: Readonly<Record<string, string>>;
}

export interface OrchestratorDeps {
  readonly engines: Pick<EngineRegistry, 'get'>;
  resolveAgent(name: string): AgentDefinition | undefined;
  resolveWorkflow(name: string): WorkflowDefinition | undefined;
  /** A script definition by name - `script: <name>` runs it instead of a shell command when it exists. */
  resolveScript?(name: string): ScriptDefinition | undefined;
  /** Executes a script step inside the task workspace with the given inputs. */
  runScript(spec: ScriptRunSpec, context: TaskRunContext): Promise<ScriptResult>;
  /** Standards text injected into this agent's system prompt; undefined = none. */
  resolveStandards?(agentName: string): string | undefined;
  /** Resolves an agent's allowlisted MCP server names to run specs. */
  resolveMcpServers?(names: readonly string[]): readonly McpServerSpec[];
  /** Skills section for this agent + what the run is about; undefined = none attach. */
  resolveSkills?(agentName: string, about: string): string | undefined;
  /**
   * Writes `_summary` for a run output that has none: the humanizer in
   * the desktop; absent (or headless) = the deterministic fallback.
   */
  summarizeOutput?(output: Readonly<Record<string, unknown>>): Promise<string | undefined>;
  /** Budget check before each agent step; pause opens the __budget__ gate. */
  checkBudget?(): Promise<{ pause: boolean }> | { pause: boolean };
  /**
   * Nobody is watching: gates approve themselves with every non-dismissed
   * item ticked and the default choice, an agent's question gets the fallback
   * answer, a permission escalation is denied, the budget gate fails the run
   * instead of pausing it, and `_summary` never costs a model call.
   */
  readonly headless?: boolean;
  emit(event: RunEvent): Promise<void> | void;
  /** Hook for usage recording; defaults to identity. */
  instrument?(events: AsyncIterable<EngineEvent>, meta: StepMeta): AsyncIterable<EngineEvent>;
}

interface Waiting {
  readonly stepId: string;
  readonly step: WorkflowStep;
  /** A gate with `select`: its checkable items and what the user has ticked so far. */
  readonly items?: readonly GateItem[];
  readonly selection?: GateSelection;
}

/** How a lane's run ended when a flow step steered the pipeline rather than the lane just finishing. */
type FlowSignal =
  | {
      readonly kind: 'goto';
      /** The goto's id as seen from the run reading the signal - scoped further at each level it climbs. */
      readonly fromStepId: string;
      readonly targetStepId: string;
      readonly maxLoops: number;
    }
  | { readonly kind: 'finish' };

/**
 * The run state and its drive loop. The step handlers live in agent-step,
 * script-step, run-fanout, run-gates and run-resume, which read and write
 * this state directly - so the fields and the helpers they use are not private.
 */
export class WorkflowRun {
  stepIndex = 0;
  status: RunStatus = 'idle';
  readonly outputs: Record<string, unknown> = {};
  readonly loopCounts = new Map<string, number>();
  readonly rejectCounts = new Map<string, number>();
  readonly runCounts = new Map<string, number>();
  pendingFeedback: { forStepId: string; note: string } | null = null;
  waiting: Waiting | null = null;
  /** Live engine sessions, tagged with the step (emit id) that owns them. */
  readonly activeSessions = new Map<EngineSession, string>();
  private readonly activeChildren = new Set<WorkflowRun>();
  /** Last resolution per gate - condition/while can branch on 'run.gates.<id>.approved'. */
  readonly gateOutcomes = new Map<string, boolean>();
  /** A live agent waiting on the user mid-run (question / permission). */
  pendingPrompt: {
    stepId: string;
    resolve: (answer: { approved: boolean; note?: string }) => void;
  } | null = null;
  /** Prompts are serialized: one card at a time, even with parallel branches asking. */
  promptQueue: Promise<unknown> = Promise.resolve();
  /** 'Bash:pnpm test' the user already allowed once - auto-allowed for the rest of the run. */
  readonly grantedPermissions = new Set<string>();
  /** A prompt that outlived its process (crash/restart) - resolving it re-runs the step. */
  revivedPrompt: string | null = null;
  /**
   * A child run paused at ITS gate/permission - a pipeline sub-workflow
   * or a condition's embedded lane. Resolutions forward into it, and
   * `after` is how the parent picks up once the child has moved on.
   */
  suspendedChild: {
    readonly step: WorkflowStep;
    readonly run: WorkflowRun;
    readonly after: (child: WorkflowRun) => Promise<boolean>;
  } | null = null;
  /** Set when this run ended on a usage/rate limit rather than a real failure or cancel. */
  private quotaInterrupt: {
    readonly message: string;
    readonly retryAt?: string;
    readonly cause: InterruptCause;
  } | null = null;
  /** Why this run failed - a parent surfaces it instead of a generic "branch failed". */
  private failureMessage: string | null = null;
  /**
   * A lane's run that ended because a flow step steered the PIPELINE - a goto
   * whose target isn't in this lane, or a finish. The parent reads it after
   * the child returns and carries the jump/finish out at its own level.
   */
  private flowSignal: FlowSignal | null = null;
  /** What the run returns - set by a finish/fail step, or the implicit last report at the end. */
  private runOutput: Record<string, unknown> | null = null;
  /** A finish/fail step named the output - a sub-workflow without one still hands back its reports by step. */
  private finishedExplicitly = false;

  constructor(
    readonly workflow: WorkflowDefinition,
    readonly context: TaskRunContext,
    readonly deps: OrchestratorDeps,
    readonly depth = 0,
  ) {}

  /** Rebuild a run from its persisted event log (crash resume). */
  static resume(
    workflow: WorkflowDefinition,
    context: TaskRunContext,
    deps: OrchestratorDeps,
    events: readonly RunEvent[],
    depth = 0,
  ): WorkflowRun {
    const run = new WorkflowRun(workflow, context, deps, depth);
    restoreRun(run, events);
    return run;
  }

  get currentStatus(): RunStatus {
    return this.status;
  }

  waitingStep(): { kind: 'gate'; stepId: string } | null {
    return this.waiting ? { kind: 'gate', stepId: this.waiting.stepId } : null;
  }

  /** Set only when this run (or a sub-workflow it was running) hit a usage/rate limit. */
  interruptedForQuota(): {
    readonly message: string;
    readonly retryAt?: string;
    readonly cause: InterruptCause;
  } | null {
    return this.quotaInterrupt;
  }

  /** The message this run failed with, if it did. */
  failureReason(): string | null {
    return this.failureMessage;
  }

  /** Set when a lane's run ended by steering the pipeline (see FlowSignal). */
  flowOutcome(): FlowSignal | null {
    return this.flowSignal;
  }

  collectedOutputs(): Readonly<Record<string, unknown>> {
    return this.outputs;
  }

  /**
   * The all-in-one result of a finished run: every output it produced, keyed
   * by step. A parent run stores this under the sub-workflow's id, so paths
   * read '<sub>.<step>.<field>' - same shape as a fork's branches.
   */
  finalReport(): Readonly<Record<string, unknown>> {
    return Object.fromEntries(
      Object.entries(this.outputs).filter(([key]) => !key.startsWith('__foreach:')),
    );
  }

  /** The LAST step's report - what blocking detection reads. */
  lastStepReport(): unknown {
    const lastStep = this.workflow.steps.at(-1);
    if (!lastStep) {
      return undefined;
    }
    return this.outputs[outputKeyOf(lastStep)];
  }

  async start(): Promise<void> {
    if (this.status !== 'idle') {
      throw new Error(`Run already ${this.status}`);
    }
    this.status = 'running';
    await this.deps.emit({
      type: 'run-started',
      workflowName: this.workflow.name,
      ...(Object.keys(this.context.inputs ?? {}).length > 0 ? { inputs: this.context.inputs } : {}),
    });
    await this.drive();
  }

  /** After resume(): continues a run that was mid-step; no-op when waiting on the user. */
  async continueRun(): Promise<void> {
    if (this.status === 'running') {
      await this.drive();
    }
  }

  resolveGate(
    stepId: string,
    approved: boolean,
    note?: string,
    answer?: GateAnswer,
    by?: 'headless',
  ): Promise<void> {
    return resolveGate(this, stepId, approved, note, answer, by);
  }

  /** Ticks, dismissals, edits on the open gate - persisted as an event so a restart shows the same list. */
  updateGateSelection(stepId: string, patch: Partial<GateSelection>): Promise<GateSelection> {
    return updateGateSelection(this, stepId, patch);
  }

  cancel(): void {
    if (isTerminal(this.status)) {
      return;
    }
    this.status = 'cancelled';
    this.pendingPrompt?.resolve({ approved: false });
    this.pendingPrompt = null;
    this.suspendedChild?.run.cancel();
    this.suspendedChild = null;
    for (const child of this.activeChildren) {
      child.cancel();
    }
    for (const session of this.activeSessions.keys()) {
      session.cancel();
    }
    void this.deps.emit({ type: 'run-cancelled' });
  }

  async drive(): Promise<void> {
    while (this.status === 'running') {
      if (this.stepIndex >= this.workflow.steps.length) {
        this.status = 'completed';
        // No finish step ran: the output is the last step's report. Only the
        // top-level run writes `_summary` - a child's result is its parent's business.
        const implicit = this.runOutput ?? implicitOutput(this.lastStepReport());
        this.runOutput =
          this.depth === 0
            ? await this.withSummary(implicit, `${this.workflow.title} finished`)
            : implicit;
        await this.deps.emit({
          type: 'run-completed',
          output: this.runOutput,
          outputs: this.finalReport(),
        });
        return;
      }
      const step = this.workflow.steps[this.stepIndex] as WorkflowStep;
      if (await this.skipByRunPolicy(step)) {
        this.stepIndex += 1;
        continue;
      }
      if (
        (step.kind === 'agent' || step.kind === 'parallel' || step.kind === 'foreach') &&
        this.deps.checkBudget
      ) {
        const verdict = await this.deps.checkBudget();
        if (verdict.pause && this.deps.headless) {
          // Nobody can raise the cap: stop here, distinguishably (exit 4 in the CLI).
          await this.failRun(
            'The task hit its budget cap - a headless run stops here instead of asking; raise the cap and resume',
            'budget',
          );
          return;
        }
        if (verdict.pause) {
          // The cap is a pause, never a kill: the user decides at the gate.
          this.waiting = { stepId: BUDGET_GATE_ID, step };
          this.status = 'waiting-gate';
          await this.deps.emit({ type: 'gate-opened', stepId: BUDGET_GATE_ID, show: [] });
          return;
        }
      }
      switch (step.kind) {
        case 'agent': {
          const completed = await runAgentStep(this, step);
          if (!completed) {
            return;
          }
          break;
        }
        case 'script': {
          const completed = await runScriptStep(this, step);
          if (!completed) {
            return;
          }
          this.stepIndex += 1;
          break;
        }
        case 'gate': {
          await openGate(this, step.id, step.show);
          if (this.deps.headless) {
            await this.resolveGate(
              step.id,
              true,
              undefined,
              headlessAnswer(this, step),
              'headless',
            );
          }
          return;
        }
        case 'workflow': {
          const proceed = await this.runSubWorkflowStep(step);
          if (!proceed) {
            return;
          }
          break;
        }
        case 'condition': {
          const value = this.valueAtPath(step.path);
          const result = matchesComparator(value, step.compare);
          const branch = result ? step.then : step.else;
          // The condition's own output - `<id>.result` / `<id>.branch` are readable after the lanes merge.
          recordOutput(this.outputs, step, {
            path: step.path,
            value: capValue(value),
            result,
            branch: result ? 'then' : 'else',
            ...(branch?.kind === 'goto' ? { jumpedTo: branch.stepId } : {}),
          });
          await this.deps.emit({
            type: 'condition-evaluated',
            stepId: step.id,
            path: step.path,
            ...(value === undefined ? {} : { value: capValue(value) }),
            result,
            ...(branch?.kind === 'goto' ? { to: branch.stepId } : {}),
          });
          if (!branch) {
            this.stepIndex += 1;
            break;
          }
          if (branch.kind === 'goto') {
            const target = this.indexOfStep(branch.stepId);
            if (target < 0) {
              await this.failRun(`Condition '${step.id}' targets unknown step '${branch.stepId}'`);
              return;
            }
            this.stepIndex = target;
            break;
          }
          const proceed = await this.runConditionBranch(step, branch.steps);
          if (!proceed) {
            return;
          }
          break;
        }
        case 'while': {
          const value = this.valueAtPath(step.path);
          const count = this.loopCounts.get(step.id) ?? 0;
          const looped = matchesComparator(value, step.compare) && count < step.maxLoops;
          recordOutput(this.outputs, step, {
            path: step.path,
            value: capValue(value),
            looped,
            iteration: looped ? count + 1 : count,
            maxLoops: step.maxLoops,
          });
          await this.deps.emit({
            type: 'condition-evaluated',
            stepId: step.id,
            path: step.path,
            ...(value === undefined ? {} : { value: capValue(value) }),
            result: looped,
            loop: true,
          });
          if (looped) {
            const target = this.indexOfStep(step.gotoStepId);
            if (target < 0) {
              await this.failRun(`While '${step.id}' loops to unknown step '${step.gotoStepId}'`);
              return;
            }
            this.loopCounts.set(step.id, count + 1);
            // The target shouldn't redo its work blind: hand it WHY it's
            // looping and the latest report the comparison read.
            const root = step.path.split('.')[0] ?? '';
            const note = capText(
              `Looping back (${count + 1}/${step.maxLoops}) because ${step.path} = ${JSON.stringify(
                capValue(value),
              )}. Latest '${root}' report:\n${JSON.stringify(this.outputs[root] ?? null, null, 2)}`,
              4_000,
            );
            this.pendingFeedback = { forStepId: step.gotoStepId, note };
            await this.deps.emit({
              type: 'loop-back',
              fromStepId: step.id,
              toStepId: step.gotoStepId,
              iteration: count + 1,
              reason: 'while',
              note,
            });
            clearForkMemos(this.workflow.steps, this.outputs, target, this.stepIndex);
            this.stepIndex = target;
          } else {
            this.stepIndex += 1;
          }
          break;
        }
        case 'parallel': {
          const completed = await runParallel(this, step);
          if (!completed) {
            return;
          }
          const proceed = await handleForkBlocking(this, step);
          if (!proceed) {
            return;
          }
          break;
        }
        case 'foreach': {
          const completed = await runForEach(this, step);
          if (!completed) {
            return;
          }
          const proceed = await handleForkBlocking(this, step);
          if (!proceed) {
            return;
          }
          break;
        }
        case 'goto': {
          const outcome = await this.applyGoto(step.id, step.targetStepId, step.maxLoops);
          recordOutput(this.outputs, step, {
            target: step.targetStepId,
            jumped: outcome === 'jumped',
            iteration: this.loopCounts.get(step.id) ?? 0,
            maxLoops: step.maxLoops,
          });
          if (outcome === 'stopped') {
            return;
          }
          if (outcome === 'exhausted') {
            this.stepIndex += 1;
          }
          break;
        }
        case 'finish': {
          this.runOutput = this.stepOutput(step);
          this.finishedExplicitly = true;
          await this.deps.emit({ type: 'step-completed', stepId: step.id, report: this.runOutput });
          if (!this.finishRun()) {
            return;
          }
          break;
        }
        case 'fail': {
          this.finishedExplicitly = true;
          await this.failRun(step.message, undefined, this.stepOutput(step));
          return;
        }
      }
    }
  }

  /**
   * Runs a child (sub-workflow, condition lane or fork branch) to its end or
   * its pause. It starts out seeing everything this run has produced so far,
   * so a step in it reads upstream outputs exactly like a sibling would.
   */
  async startChild(
    workflow: WorkflowDefinition,
    emitPrefix: string,
    deps: OrchestratorDeps = this.deps,
  ): Promise<WorkflowRun> {
    const child = new WorkflowRun(
      workflow,
      this.context,
      { ...deps, emit: (event) => this.emitChildEvent(emitPrefix, event) },
      this.depth + 1,
    );
    Object.assign(child.outputs, this.outputs);
    this.activeChildren.add(child);
    try {
      await child.start();
    } finally {
      this.activeChildren.delete(child);
    }
    return child;
  }

  /** Rebuilds a paused child from its slice of this run's log, seeing this run's outputs as it did live. */
  resumeChild(
    workflow: WorkflowDefinition,
    emitPrefix: string,
    events: readonly RunEvent[],
    deps: OrchestratorDeps = this.deps,
  ): WorkflowRun {
    const child = WorkflowRun.resume(
      workflow,
      this.context,
      { ...deps, emit: (event) => this.emitChildEvent(emitPrefix, event) },
      [
        {
          type: 'run-started',
          workflowName: workflow.name,
          ...(Object.keys(this.context.inputs ?? {}).length > 0
            ? { inputs: this.context.inputs }
            : {}),
        },
        ...unscopeChildEvents(emitPrefix, events),
      ],
      this.depth + 1,
    );
    for (const [key, value] of Object.entries(this.outputs)) {
      if (!(key in child.outputs)) {
        child.outputs[key] = value;
      }
    }
    return child;
  }

  /** A condition's chosen embedded lane: runs then falls through to the next pipeline step. */
  private async runConditionBranch(
    step: ConditionStep,
    steps: readonly ConditionBranchStep[],
  ): Promise<boolean> {
    if (steps.length === 0) {
      this.stepIndex += 1;
      return true;
    }
    const child = await runBranchChain(this, steps, step.id, step.id);
    if (!child) {
      await this.failRun(`Workflow nesting is limited to ${MAX_NESTING_DEPTH} levels`);
      return false;
    }
    return this.afterConditionBranch(step, child);
  }

  /**
   * Where a condition's lane run leaves the parent: paused at a gate/permission
   * inside it (the parent suspends on '<condition>/<step>' exactly like a
   * sub-workflow's gate, and resolutions forward back in), failed, or done -
   * then its outputs flat-merge so downstream reads them like any sibling's.
   */
  async afterConditionBranch(step: ConditionStep, child: WorkflowRun): Promise<boolean> {
    if (this.status !== 'running') {
      return false;
    }
    if (child.currentStatus === 'waiting-gate') {
      const childWaiting = child.waitingStep();
      if (!childWaiting) {
        await this.failRun(`Condition '${step.id}' paused without a waiting step`);
        return false;
      }
      this.suspendedChild = {
        step,
        run: child,
        after: (lane) => this.afterConditionBranch(step, lane),
      };
      this.waiting = { stepId: `${step.id}/${childWaiting.stepId}`, step };
      this.status = child.currentStatus;
      return false;
    }
    if (child.currentStatus !== 'completed') {
      const quota = child.interruptedForQuota();
      if (quota) {
        await this.interruptForQuota(quota.message, quota.retryAt, quota.cause);
      } else {
        await this.failRun(child.failureReason() ?? `Condition '${step.id}' branch failed`);
      }
      return false;
    }
    Object.assign(this.outputs, branchReport(this, child));
    // `<condition>.output` - the ran side's headline (its last step's report), so one
    // name works downstream whichever side ran.
    const own = this.outputs[step.id];
    const recorded = own && typeof own === 'object' ? (own as Record<string, unknown>) : {};
    const side = recorded.branch === 'else' ? step.else : step.then;
    recordOutput(this.outputs, step, {
      ...recorded,
      output: side?.kind === 'steps' ? laneHeadline(side.steps, child.finalReport()) : null,
    });
    // A flow step in the lane steered the pipeline: carry it out at this level.
    const signal = child.flowOutcome();
    if (signal?.kind === 'finish') {
      this.runOutput = child.runOutputValue() ?? this.runOutput;
      return this.finishRun();
    }
    if (signal?.kind === 'goto') {
      const outcome = await this.applyGoto(
        `${step.id}/${signal.fromStepId}`,
        signal.targetStepId,
        signal.maxLoops,
      );
      if (outcome !== 'exhausted') {
        return outcome === 'jumped';
      }
      // the cap is spent: the lane is over and the pipeline continues past the condition
    }
    // No report payload - this only exists so replay (derive-run-state) advances stepIndex on resume.
    await this.deps.emit({ type: 'step-completed', stepId: step.id });
    this.stepIndex += 1;
    return true;
  }

  private async runSubWorkflowStep(step: SubWorkflowStep): Promise<boolean> {
    this.bumpRunCount(step.id);
    const childWorkflow = await resolveSubWorkflow(this, step, undefined);
    if (!childWorkflow) {
      return false;
    }
    await this.deps.emit({
      type: 'step-started',
      stepId: step.id,
      stepKind: 'workflow',
      attempt: 1,
    });
    const child = await this.startChild(childWorkflow, step.id);
    return this.afterChildProgress(step, child);
  }

  /**
   * A sub-workflow runs like the step list it is: its gates and
   * actions pause the parent too, surfaced under '<step>/<gate>' ids, and
   * resolutions forward back into the child until it finishes.
   */
  async afterChildProgress(step: SubWorkflowStep, child: WorkflowRun): Promise<boolean> {
    if (this.status !== 'running') {
      return false;
    }
    if (child.currentStatus === 'waiting-gate') {
      const childWaiting = child.waitingStep();
      if (!childWaiting) {
        await this.failRun(`Sub-workflow '${step.id}' paused without a waiting step`);
        return false;
      }
      this.suspendedChild = {
        step,
        run: child,
        after: (sub) => this.afterChildProgress(step, sub),
      };
      this.waiting = { stepId: `${step.id}/${childWaiting.stepId}`, step };
      this.status = child.currentStatus;
      return false;
    }
    if (child.currentStatus !== 'completed') {
      const quota = child.interruptedForQuota();
      if (quota) {
        await this.interruptForQuota(quota.message, quota.retryAt, quota.cause);
      } else {
        const reason = child.failureReason();
        await this.failRun(
          `Sub-workflow '${step.id}' ${child.currentStatus}${reason ? `: ${reason}` : ''}`,
        );
      }
      return false;
    }

    // A sub-workflow's result is its finish step's output; with no finish, its own reports by step.
    const report = child.finishedExplicitly
      ? (child.runOutputValue() ?? branchReport(this, child))
      : branchReport(this, child);
    recordOutput(this.outputs, step, report);
    await this.deps.emit({ type: 'step-completed', stepId: step.id, report });
    return this.handleBlockingAndAdvance(step, child.lastStepReport());
  }

  /**
   * Shared ending for review-style steps (agent or nested workflow): a report
   * with blocking: true rewinds to the declared step while loops remain, then
   * either fails or asks the user; anything else advances.
   */
  async handleBlockingAndAdvance(
    step: AgentStep | SubWorkflowStep,
    report: unknown,
  ): Promise<boolean> {
    if (step.onBlocking && isBlockingReport(report)) {
      return this.loopBackOnBlocking(step.id, step.onBlocking, report, step);
    }
    this.stepIndex += 1;
    return true;
  }

  async loopBackOnBlocking(
    stepId: string,
    policy: OnBlockingPolicy,
    findings: unknown,
    gateStep?: AgentStep | SubWorkflowStep,
  ): Promise<boolean> {
    const used = this.loopCounts.get(stepId) ?? 0;
    if (used < policy.maxLoops) {
      this.loopCounts.set(stepId, used + 1);
      const note = `The review found blocking issues. Findings:\n${JSON.stringify(findings, null, 2)}`;
      this.pendingFeedback = { forStepId: policy.gotoStepId, note };
      await this.deps.emit({
        type: 'loop-back',
        fromStepId: stepId,
        toStepId: policy.gotoStepId,
        iteration: used + 1,
        reason: 'blocking-review',
        note,
      });
      const target = this.indexOfStep(policy.gotoStepId);
      clearForkMemos(this.workflow.steps, this.outputs, target, this.stepIndex);
      this.stepIndex = target;
      return true;
    }
    if (policy.then === 'fail') {
      await this.failRun(
        `'${stepId}' still reports blocking issues after ${policy.maxLoops} loops`,
      );
      return false;
    }
    await openGate(this, stepId, ['report'], gateStep);
    return false;
  }

  /** Loop-aware run policy (when.max_runs): skip a step that has run its quota. */
  private async skipByRunPolicy(step: WorkflowStep): Promise<boolean> {
    const when = 'when' in step ? step.when : undefined;
    if (!when) {
      return false;
    }
    const runs = this.runCounts.get(step.id) ?? 0;
    if (runs < when.maxRuns) {
      return false;
    }
    await this.deps.emit({
      type: 'step-skipped',
      stepId: step.id,
      reason:
        when.maxRuns === 1
          ? 'runs on the first pass only'
          : `already ran ${runs}× (max ${when.maxRuns})`,
    });
    return true;
  }

  bumpRunCount(stepId: string): void {
    this.runCounts.set(stepId, (this.runCounts.get(stepId) ?? 0) + 1);
  }

  /**
   * What a finish or fail step hands out: positional references under
   * their names, `with:` fields on top (`$ref` resolved). The run's output.
   */
  private stepOutput(step: FinishStep | FailStep): Record<string, unknown> {
    const readable = this.readable();
    const output: Record<string, unknown> = {};
    for (const ref of step.input ?? []) {
      output[ref] = readOutputPath(readable, ref) ?? null;
    }
    return { ...output, ...(step.params ? this.resolveParams(step.params) : {}) };
  }

  /** Every output carries `_summary`: the author's, the humanizer's, or a plain line. */
  private async withSummary(
    output: Record<string, unknown>,
    fallback: string,
  ): Promise<Record<string, unknown>> {
    if (typeof output['_summary'] === 'string' && output['_summary'].trim().length > 0) {
      return output;
    }
    if (this.deps.summarizeOutput && !this.deps.headless) {
      const written = await this.deps.summarizeOutput(output).catch(() => undefined);
      if (written && written.trim().length > 0) {
        return { ...output, _summary: written.trim() };
      }
    }
    return { ...output, _summary: fallback };
  }

  /**
   * `with:` params may name outputs: a string of the form `$ref` (`$pr`,
   * `$triage.selected`, `$standards.risk`) is replaced by that value (undefined
   * when nothing produced it); anything else passes through, nested objects and
   * arrays included.
   */
  resolveParams(params: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
    const readable = this.readable();
    const resolve = (value: unknown): unknown => {
      if (typeof value === 'string') {
        const match = /^\$([A-Za-z_][\w-]*(?:\.[\w-]+)*)$/.exec(value);
        return match?.[1] ? readOutputPath(readable, match[1]) : value;
      }
      if (Array.isArray(value)) {
        return value.map(resolve);
      }
      if (value && typeof value === 'object') {
        return Object.fromEntries(
          Object.entries(value).map(([key, entry]) => [key, resolve(entry)]),
        );
      }
      return value;
    };
    return resolve(params) as Readonly<Record<string, unknown>>;
  }

  private emitChildEvent(parentStepId: string, event: RunEvent): Promise<void> | void {
    const scoped = scopeChildEvent(parentStepId, event);
    if (scoped) {
      return this.deps.emit(scoped);
    }
  }

  /**
   * What condition/while compare against: step outputs, plus the synthetic
   * 'run' root exposing run state - 'run.gates.<id>.approved',
   * 'run.rejections.<id>', 'run.loops.<id>', 'run.runs.<id>'.
   */
  valueAtPath(path: string): unknown {
    return readOutputPath(this.readable(), path);
  }

  /** Everything a reference can resolve against: every output (under step id and alias) plus the `run` root. */
  readable(extra?: Record<string, unknown>): Record<string, unknown> {
    return {
      ...this.outputs,
      inputs: this.context.inputs,
      run: this.runState(),
      ...(extra ?? {}),
    };
  }

  private runState(): Record<string, unknown> {
    return {
      loops: Object.fromEntries(this.loopCounts),
      rejections: Object.fromEntries(this.rejectCounts),
      runs: Object.fromEntries(this.runCounts),
      gates: Object.fromEntries(
        [...this.gateOutcomes].map(([stepId, approved]) => [
          stepId,
          { approved, rejections: this.rejectCounts.get(stepId) ?? 0 },
        ]),
      ),
    };
  }

  /** A branch failing under on_fail: continue/ask must not kill the run. */
  async stepFailure(message: string, soft: boolean | undefined): Promise<false> {
    if (!soft) {
      await this.failRun(message);
    }
    return false;
  }

  async failRun(
    message: string,
    cause?: 'budget',
    output?: Record<string, unknown>,
  ): Promise<void> {
    this.status = 'failed';
    this.failureMessage = message;
    if (output) {
      // a fail step's structured result - its `_summary` is the message unless the author wrote one
      this.runOutput =
        typeof output['_summary'] === 'string' ? output : { ...output, _summary: message };
    }
    await this.deps.emit({
      type: 'run-failed',
      message,
      ...(cause ? { cause } : {}),
      ...(this.runOutput ? { output: this.runOutput } : {}),
    });
  }

  /** The run's result once it ended: a finish/fail step's object, or the implicit last report. */
  runOutputValue(): Readonly<Record<string, unknown>> | null {
    return this.runOutput;
  }

  /**
   * A finish step: the WHOLE run ends successfully here. At the top the step
   * pointer runs off the end so drive() completes normally; inside a lane the
   * finish is handed up for the owning run to carry out.
   */
  private finishRun(): boolean {
    if (this.depth === 0) {
      this.stepIndex = this.workflow.steps.length;
      return true;
    }
    this.flowSignal = { kind: 'finish' };
    this.status = 'completed';
    return false;
  }

  /**
   * A goto's jump, at whichever level owns the target. `countKey` is the
   * goto's id as seen from here ('<condition>/<goto>' once it has climbed out
   * of a lane) - also the loop-back's fromStepId, so the count is replayed on
   * resume and survives the lane being re-entered. Past its cap it falls
   * through ('exhausted'); a target that lives further out is handed up.
   */
  private async applyGoto(
    countKey: string,
    targetStepId: string,
    maxLoops: number,
  ): Promise<'jumped' | 'exhausted' | 'stopped'> {
    const count = this.loopCounts.get(countKey) ?? 0;
    if (count >= maxLoops) {
      await this.deps.emit({
        type: 'step-skipped',
        stepId: countKey,
        reason: `go to '${targetStepId}' has used its ${maxLoops} jumps - continuing`,
      });
      return 'exhausted';
    }
    // not indexOfStep: an id that isn't here is the normal "belongs to an enclosing run" case
    const target = this.workflow.steps.findIndex((step) => step.id === targetStepId);
    if (target < 0) {
      if (this.depth === 0) {
        await this.failRun(`Go to '${countKey}' targets unknown step '${targetStepId}'`);
        return 'stopped';
      }
      this.flowSignal = { kind: 'goto', fromStepId: countKey, targetStepId, maxLoops };
      this.status = 'completed';
      return 'stopped';
    }
    this.loopCounts.set(countKey, count + 1);
    await this.deps.emit({
      type: 'loop-back',
      fromStepId: countKey,
      toStepId: targetStepId,
      iteration: count + 1,
      reason: 'goto',
    });
    clearForkMemos(this.workflow.steps, this.outputs, target, this.stepIndex);
    this.stepIndex = target;
    return 'jumped';
  }

  /**
   * A usage/rate limit ends the run the same way a crash does (cancelled, then
   * Resume) rather than as a failure: retrying immediately is futile, and
   * every other branch on the same engine would hit the same wall, so this
   * always wins over a fork's on_fail policy. Resume replays the event log and
   * re-runs the interrupted step, exactly like restarting after a crash.
   */
  async interruptForQuota(
    message: string,
    retryAt?: string,
    cause: InterruptCause = 'quota',
  ): Promise<void> {
    this.status = 'cancelled';
    this.quotaInterrupt = { message, cause, ...(retryAt ? { retryAt } : {}) };
    await this.deps.emit({
      type: 'run-interrupted',
      reason: message,
      cause,
      ...(retryAt ? { retryAt } : {}),
    });
  }

  nearestPrecedingAgentStep(): AgentStep | null {
    for (
      let index = Math.min(this.stepIndex, this.workflow.steps.length - 1);
      index >= 0;
      index -= 1
    ) {
      const candidate = this.workflow.steps[index];
      if (candidate?.kind === 'agent') {
        return candidate;
      }
    }
    return null;
  }

  indexOfStep(stepId: string): number {
    const index = this.workflow.steps.findIndex((step) => step.id === stepId);
    if (index < 0) {
      throw new Error(`Unknown step '${stepId}'`);
    }
    return index;
  }

  stepById(stepId: string): WorkflowStep | undefined {
    return this.workflow.steps.find((step) => step.id === stepId);
  }
}

/** Structured comparison - the whole language. No eval, no surprises. */
export function matchesComparator(value: unknown, compare: Comparator): boolean {
  switch (compare.op) {
    case 'equals':
      return value === compare.value;
    case 'not_equals':
      return value !== compare.value;
    case 'gte':
      return (
        typeof value === 'number' && typeof compare.value === 'number' && value >= compare.value
      );
    case 'lte':
      return (
        typeof value === 'number' && typeof compare.value === 'number' && value <= compare.value
      );
    case 'in':
      return Array.isArray(compare.value) && compare.value.includes(value);
    case 'truthy':
      return Boolean(value);
  }
}

/** Events persist forever - a fat output value has no business in one. */
function capValue(value: unknown): unknown {
  if (typeof value === 'string' && value.length > 200) {
    return `${value.slice(0, 200)}…`;
  }
  if (typeof value === 'object' && value !== null) {
    return '[object]';
  }
  return value;
}

/** No finish step: the last report is the output when it is an object, else it sits under `result`. */
function implicitOutput(report: unknown): Record<string, unknown> {
  if (report && typeof report === 'object' && !Array.isArray(report)) {
    return { ...(report as Record<string, unknown>) };
  }
  if (report === undefined) {
    return {};
  }
  return { result: report };
}
