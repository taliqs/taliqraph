import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { GateStep } from '../definitions/workflow/workflow-step';
import type { WorkflowDefinition } from '../definitions/workflow/workflow-definition';
import type { ResolvedDefinitions } from '../definitions/definition-set';
import { DEFAULT_SCRIPT_TIMEOUT_MINUTES } from '../definitions/script/script-definition';
import { describeMissingMcpServers, parseMcpName } from '../definitions/workflow/mcp-requirements';
import { renderSkillsFor } from '../definitions/skill/render-skills-for';
import { renderStandardsFor } from '../definitions/standard/render-standards-for';
import type { GateAnswer, RunEvent, RunStatus } from '../orchestrator/run-event';
import type { OrchestratorDeps, TaskRunContext } from '../orchestrator/workflow-run';
import { WorkflowRun } from '../orchestrator/workflow-run';
import { createDefaultEngines } from '../engines/default-engines';
import { declaredSecretsOf, resolveSecrets } from '../secrets/resolve-secrets';
import { redactSecrets, stepBaseEnvironment } from '../secrets/step-environment';
import { resolveTaskInputs } from '../steps/resolve-task-inputs';
import { runWorkflowScript } from '../steps/run-workflow-script';
import { pausingStepIds } from './find-pauses';
import { applyGateDecision, gateRequestOf, openGateOf } from './gate-request';
import type { LoadedPackage } from './load-package';
import { describeProblems, loadPackage } from './load-package';
import { lintLoadedPackage } from './lint-package';
import { metricsOf } from './run-metrics';
import type { HooksConfig, RunResult, RunWorkflowOptions, TimedRunEvent } from './types';
import { GateHandlerRequired, SecretsMissing, WorkflowInvalid } from './types';

type GateOpened = Extract<RunEvent, { type: 'gate-opened' }>;
type TerminalEvent = Extract<
  RunEvent,
  { type: 'run-completed' | 'run-failed' | 'run-cancelled' | 'run-interrupted' }
>;

const EXIT = { done: 0, failed: 1, budget: 4, cancelled: 130 } as const;

/** How long the gate handler waits for the run to park on the gate it was told about. */
const PARK_TICKS = 1000;

/**
 * Runs one workflow package in this process and returns everything about it.
 * Nothing is written anywhere but the workspace: the package is read from
 * disk, checked, run, and its event log handed back with the result.
 */
export async function runWorkflow(options: RunWorkflowOptions): Promise<RunResult> {
  const cwd = resolve(options.cwd ?? process.cwd());
  if (!existsSync(cwd)) {
    throw new Error(`${cwd} does not exist`);
  }
  const loaded = await loadPackage(options.workflow);
  const { name, workflow, scope } = loaded;
  const mcpServers = options.mcpServers ?? [];
  checkWorkflow(
    loaded,
    mcpServers.map((server) => server.name),
  );
  if (!options.onGate && !options.headless) {
    const pauses = pausingStepIds(workflow, (child) => scope.workflows.get(child));
    if (pauses.length > 0) {
      throw new GateHandlerRequired(pauses);
    }
  }

  const inputs = resolveTaskInputs(workflow, options.inputs ?? {});
  const secrets = resolveSecrets(
    declaredSecretsOf(workflow, (child) => scope.workflows.get(child)),
    { ...process.env, ...defined(options.secrets) },
  );
  if (secrets.missing.length > 0) {
    throw new SecretsMissing(name, secrets.missing);
  }
  const env = stepBaseEnvironment(workflow.env ?? [], { ...process.env, ...options.env });

  const runId = randomUUID();
  const context: TaskRunContext = {
    taskId: runId,
    projectId: cwd,
    workspacePath: cwd,
    ...(options.isolated ? { isolated: true } : {}),
    inputs: inputs.values,
    secrets: secrets.values,
    env,
  };
  const hooks: HooksConfig = options.hooks ?? {};

  const session = new RunSession(options, workflow, context, scope, hooks, inputs.title);
  const engines = options.engines ?? createDefaultEngines();
  const deps: OrchestratorDeps = {
    ...(options.headless ? { headless: true } : {}),
    engines,
    resolveAgent: (agent) => scope.agents.get(agent),
    resolveWorkflow: (child) => scope.workflows.get(child),
    resolveScript: (script) => scope.scripts.get(script),
    runScript: (spec, runContext) => runWorkflowScript(spec, runContext.workspacePath),
    resolveStandards: (agent) => renderStandardsFor(scope.standards.values(), agent),
    resolveSkills: (agent) =>
      renderSkillsFor([...scope.skills.values()], {
        explicit: scope.agents.get(agent)?.skills ?? [],
      }),
    ...(mcpServers.length > 0
      ? {
          resolveMcpServers: (names: readonly string[]) =>
            names.flatMap((raw) => {
              const spec = mcpServers.find((server) => server.name === parseMcpName(raw).name);
              return spec ? [spec] : [];
            }),
        }
      : {}),
    emit: (event) => session.emit(event),
  };

  await session.run(deps);
  return session.result(cwd);
}

/** Unparsable files, the linter's errors, and MCP servers the agents need but the host did not offer. */
function checkWorkflow(loaded: LoadedPackage, configuredMcp: readonly string[]): void {
  if (loaded.problems.length > 0) {
    throw new Error(describeProblems(loaded.name, loaded.dir, loaded.problems));
  }
  const { lint, missingMcp } = lintLoadedPackage(loaded, configuredMcp);
  const errors = lint.problems.filter((problem) => problem.severity === 'error');
  if (errors.length > 0) {
    throw new WorkflowInvalid(loaded.name, errors);
  }
  if (missingMcp.length > 0) {
    throw new Error(describeMissingMcpServers(loaded.name, missingMcp));
  }
}

function defined(
  values: Readonly<Record<string, string | undefined>> | undefined,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values ?? {}).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

function isTerminalStatus(status: RunStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

/**
 * One run's live state: the log it collects, the gate handling it schedules
 * off the orchestrator's emit, and the promise that settles when the run has
 * ended for good (a run parked at a gate returns from start() early).
 */
class RunSession {
  readonly events: TimedRunEvent[] = [];
  private live: WorkflowRun | null = null;
  private terminal: TerminalEvent | null = null;
  private crash: string | null = null;
  private gateChain: Promise<void> = Promise.resolve();
  private readonly secretValues: readonly string[];
  private endRun: () => void = () => undefined;
  private readonly ended = new Promise<void>((resolveEnd) => {
    this.endRun = resolveEnd;
  });

  constructor(
    private readonly options: RunWorkflowOptions,
    private readonly workflow: WorkflowDefinition,
    private readonly context: TaskRunContext,
    private readonly scope: ResolvedDefinitions,
    private readonly hooks: HooksConfig,
    private readonly title: string,
  ) {
    this.secretValues = Object.values(context.secrets ?? {});
  }

  async run(deps: OrchestratorDeps): Promise<void> {
    const { signal, resumeFrom } = this.options;
    const onAbort = (): void => this.live?.cancel();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      if (resumeFrom) {
        const startedAt = new Date().toISOString();
        this.events.push(...resumeFrom.map((event) => stamp(event, startedAt)));
        await this.emit({ type: 'run-resumed' });
        this.live = WorkflowRun.resume(this.workflow, this.context, deps, [
          ...resumeFrom,
          { type: 'run-resumed' },
        ]);
      } else {
        this.live = new WorkflowRun(this.workflow, this.context, deps);
      }
      const run = this.live;
      if (signal?.aborted) {
        run.cancel();
      } else if (resumeFrom) {
        if (run.currentStatus === 'waiting-gate') {
          this.reopenGate(run, resumeFrom);
        } else if (run.currentStatus === 'running') {
          await run.continueRun();
        } else {
          await run.failRun(`The earlier run already ended (${run.currentStatus})`);
        }
      } else {
        await run.start();
      }
      await this.ended;
      await this.gateChain;
    } catch (cause) {
      this.crash = `Run crashed: ${cause instanceof Error ? cause.message : String(cause)}`;
      await this.live?.failRun(this.crash).catch(() => undefined);
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  result(workspace: string): RunResult {
    const final = this.terminal;
    const output =
      final && (final.type === 'run-completed' || final.type === 'run-failed')
        ? final.output
        : undefined;
    const summary = output?.['_summary'];
    const status: RunResult['status'] =
      final?.type === 'run-completed'
        ? 'done'
        : final?.type === 'run-cancelled' || final?.type === 'run-interrupted'
          ? 'cancelled'
          : 'failed';
    const message =
      final?.type === 'run-failed'
        ? final.message
        : final?.type === 'run-interrupted'
          ? final.reason
          : final?.type === 'run-cancelled'
            ? 'The run was cancelled'
            : final
              ? undefined
              : (this.crash ?? 'The run ended without a result');
    const exitCode =
      status === 'done'
        ? EXIT.done
        : status === 'cancelled'
          ? EXIT.cancelled
          : final?.type === 'run-failed' && final.cause === 'budget'
            ? EXIT.budget
            : EXIT.failed;
    return {
      status,
      ...(output ? { output } : {}),
      ...(typeof summary === 'string' && summary.trim().length > 0
        ? { summary: summary.trim() }
        : {}),
      ...(message ? { message } : {}),
      workspace,
      metrics: metricsOf(
        this.events,
        (agent) => this.scope.agents.get(agent)?.engine,
        (stepId) => this.workflow.steps.find((step) => step.id === stepId)?.kind,
      ),
      events: this.events,
      exitCode,
    };
  }

  /** Stamps, redacts, collects, forwards; then the side effects an event carries. */
  async emit(raw: RunEvent): Promise<void> {
    const event = this.secretValues.length > 0 ? redactSecrets(raw, this.secretValues) : raw;
    const timed = stamp(event, new Date().toISOString());
    // live typing is for the host's display only; the complete text follows as agent-text
    if (event.type !== 'agent-text-partial') {
      this.events.push(timed);
    }
    this.options.onEvent?.(timed);
    if (event.type === 'gate-opened' && !this.options.headless) {
      this.schedule(() => this.answerGate(event));
    }
    if (
      (event.type === 'step-completed' && !event.stepId.includes('/')) ||
      event.type === 'run-completed'
    ) {
      await this.runHook(event.type === 'run-completed' ? 'after_task' : 'after_step');
    }
    if (
      event.type === 'run-completed' ||
      event.type === 'run-failed' ||
      event.type === 'run-cancelled' ||
      event.type === 'run-interrupted'
    ) {
      this.terminal = event;
      this.endRun();
    }
  }

  /** Gates are answered one at a time, off the emit that opened them, so the run has parked first. */
  private schedule(work: () => Promise<void>): void {
    this.gateChain = this.gateChain.then(work).catch(async (cause: unknown) => {
      const run = this.live;
      if (run && !isTerminalStatus(run.currentStatus)) {
        await run.failRun(cause instanceof Error ? cause.message : String(cause));
        stopLiveWork(run);
      }
    });
  }

  private async answerGate(event: GateOpened): Promise<void> {
    const run = this.live;
    if (!run) {
      return;
    }
    await parkedOn(run, event.stepId);
    if (isTerminalStatus(run.currentStatus)) {
      return;
    }
    const { onGate } = this.options;
    if (!onGate) {
      await run.failRun(
        `'${event.stepId}' paused the run with ${event.promptKind === 'permission' ? 'a permission ask' : event.promptKind === 'question' ? 'a question' : 'a gate'} and nothing can answer it - pass onGate, or headless to auto-answer`,
      );
      stopLiveWork(run);
      return;
    }
    const request = gateRequestOf(event);
    const decision = await onGate(request);
    if (isTerminalStatus(run.currentStatus)) {
      return;
    }
    await applyGateDecision(run, request, decision);
  }

  /** A resumed run parked at a gate: the gate is put to the host again, or answered the headless way. */
  private reopenGate(run: WorkflowRun, log: readonly RunEvent[]): void {
    const open = openGateOf(log);
    const waiting = run.waiting;
    if (!open || !waiting || waiting.stepId !== open.stepId) {
      this.schedule(() =>
        run.failRun('The earlier run stopped at a gate the log does not describe'),
      );
      return;
    }
    if (this.options.headless) {
      const approved = open.promptKind !== 'permission';
      const answer =
        waiting.step.kind === 'gate'
          ? headlessAnswerFor(waiting.step, waiting.selection?.selected.length ?? 0)
          : undefined;
      this.schedule(() => run.resolveGate(open.stepId, approved, undefined, answer, 'headless'));
      return;
    }
    this.schedule(() => this.answerGate(open));
  }

  /** A hook is a plain shell command in the workspace: no bound inputs, the default script timeout; failures inform, never fail. */
  private async runHook(hook: 'after_step' | 'after_task'): Promise<void> {
    const command = hook === 'after_step' ? this.hooks.afterStep : this.hooks.afterTask;
    if (!command) {
      return;
    }
    const result = await runWorkflowScript(
      {
        command,
        inputs: { task: this.title },
        timeoutMs: DEFAULT_SCRIPT_TIMEOUT_MINUTES * 60_000,
      },
      this.context.workspacePath,
    ).catch((cause: unknown) => ({
      exitCode: 1,
      stdout: '',
      stderr: cause instanceof Error ? cause.message : String(cause),
    }));
    await this.emit({
      type: 'hook-ran',
      hook,
      command,
      exitCode: result.exitCode,
      ...(result.exitCode !== 0 ? { output: (result.stderr || result.stdout).slice(0, 800) } : {}),
    });
  }
}

function stamp(event: RunEvent, at: string): TimedRunEvent {
  const own = (event as { at?: unknown }).at;
  return { ...event, at: typeof own === 'string' ? own : at } as TimedRunEvent;
}

/** The orchestrator parks on a gate right after the emit that announced it returns; wait for that. */
async function parkedOn(run: WorkflowRun, stepId: string): Promise<void> {
  for (let tick = 0; tick < PARK_TICKS; tick += 1) {
    if (isTerminalStatus(run.currentStatus)) {
      return;
    }
    if (run.currentStatus === 'waiting-gate' && run.waiting?.stepId === stepId) {
      return;
    }
    await new Promise<void>((resolveTick) => setImmediate(resolveTick));
  }
}

/** A failed run still has an agent waiting on its answer, and a session streaming: let both go. */
function stopLiveWork(run: WorkflowRun): void {
  run.pendingPrompt?.resolve({ approved: false });
  run.pendingPrompt = null;
  for (const session of run.activeSessions.keys()) {
    session.cancel();
  }
}

/**
 * The exit a headless run takes at a gate with choices: the default, else the
 * first; one that needs ticks falls back to one that needs none when nothing is ticked.
 */
function headlessAnswerFor(gate: GateStep, ticked: number): GateAnswer | undefined {
  const preferred = gate.choices?.find((choice) => choice.default) ?? gate.choices?.[0];
  if (!preferred) {
    return undefined;
  }
  const choice =
    preferred.needs === 'selection' && gate.gate === 'select' && ticked === 0
      ? (gate.choices?.find((candidate) => candidate.needs === 'none') ?? preferred)
      : preferred;
  return { choice: choice.id };
}
