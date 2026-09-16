import type { AgentDefinition } from '../definitions/agent/agent-definition';
import type { AgentStep } from '../definitions/workflow/workflow-step';
import type { EngineRunSpec, McpServerSpec } from '../engines/engine-adapter';
import { buildStepInput } from './build-step-input';
import { capToolInput } from './cap-tool-input';
import { recordOutput } from './output-keys';
import { isTerminal } from './run-event';
import { promptUser } from './run-gates';
import { stepEnvironment } from './step-environment';
import { summarizeToolInput } from './summarize-tool-input';
import type { StepMeta, TaskRunContext, WorkflowRun } from './workflow-run';

const AGENT_STEP_ATTEMPTS = 2;

export async function runAgentStep(
  run: WorkflowRun,
  step: AgentStep,
  options?: {
    emitPrefix?: string;
    detached?: boolean;
    extraOutputs?: Record<string, unknown>;
    soft?: boolean;
  },
): Promise<boolean> {
  const emitId = options?.emitPrefix ? `${options.emitPrefix}/${step.id}` : step.id;
  run.bumpRunCount(step.id);
  const agent = run.deps.resolveAgent(step.agent);
  if (!agent) {
    return run.stepFailure(`Unknown agent '${step.agent}' in step '${step.id}'`, options?.soft);
  }
  const engine = run.deps.engines.get(agent.engine);
  if (!engine) {
    return run.stepFailure(
      `Engine '${agent.engine}' is not available for agent '${agent.name}'`,
      options?.soft,
    );
  }

  let feedbackNote: string | undefined;
  if (!options?.detached && run.pendingFeedback?.forStepId === step.id) {
    feedbackNote = run.pendingFeedback.note;
    run.pendingFeedback = null;
  }
  const spec = buildRunSpec(
    agent,
    step,
    run.context,
    run.readable(options?.extraOutputs),
    feedbackNote,
    run.deps.resolveStandards?.(agent.name),
    run.deps.resolveMcpServers?.(agent.tools.mcp) ?? [],
    run.deps.resolveSkills?.(agent.name, aboutText(run.context.inputs)),
  );
  const meta: StepMeta = {
    stepId: emitId,
    agentName: agent.name,
    engineId: agent.engine,
    model: spec.model,
    ...(spec.effort ? { effort: spec.effort } : {}),
  };

  for (let attempt = 1; attempt <= AGENT_STEP_ATTEMPTS; attempt += 1) {
    await run.deps.emit({
      type: 'step-started',
      stepId: emitId,
      stepKind: 'agent',
      attempt,
      ...(step.input.length > 0 ? { input: step.input } : {}),
      agentName: agent.name,
      model: spec.model,
      ...(spec.effort ? { effort: spec.effort } : {}),
    });
    const session = engine.startSession({
      ...spec,
      onPermissionRequest: async ({ toolName, detail }) => {
        const key = `${toolName}:${detail}`;
        if (run.grantedPermissions.has(key)) {
          return true;
        }
        const ask =
          toolName === 'Bash'
            ? `The agent wants to run a command outside its allowlist:\n${detail}`
            : `The agent wants to use ${detail}`;
        const answer = await promptUser(run, emitId, 'permission', ask);
        if (answer.approved) {
          run.grantedPermissions.add(key);
        }
        return answer.approved;
      },
    });
    run.activeSessions.set(session, emitId);
    let report: unknown;
    let sawDone = false;
    let errorMessage: string | null = null;
    let quotaRetryAt: string | undefined;
    let isQuotaError = false;
    let isAuthError = false;

    const stream = run.deps.instrument
      ? run.deps.instrument(session.events(), meta)
      : session.events();
    try {
      for await (const event of stream) {
        if (isTerminal(run.status)) {
          return false;
        }
        if (event.type === 'text-delta') {
          await run.deps.emit({ type: 'agent-text', stepId: emitId, text: event.text });
        } else if (event.type === 'text-partial') {
          await run.deps.emit({ type: 'agent-text-partial', stepId: emitId, text: event.text });
        } else if (event.type === 'tool-call') {
          const detail = relativizeDetail(
            summarizeToolInput(event.input),
            run.context.workspacePath,
          );
          const cappedInput = capToolInput(event.input);
          await run.deps.emit({
            type: 'agent-tool-call',
            stepId: emitId,
            callId: event.callId,
            toolName: event.toolName,
            ...(detail ? { detail } : {}),
            ...(cappedInput !== undefined ? { input: cappedInput } : {}),
          });
        } else if (event.type === 'tool-result') {
          await run.deps.emit({
            type: 'agent-tool-result',
            stepId: emitId,
            callId: event.callId,
            isError: event.isError,
          });
        } else if (event.type === 'usage') {
          await run.deps.emit({
            type: 'step-usage',
            stepId: emitId,
            tokensIn: event.usage.tokensIn,
            tokensOut: event.usage.tokensOut,
            ...(typeof event.usage.costUsd === 'number' ? { costUsd: event.usage.costUsd } : {}),
          });
        } else if (event.type === 'done') {
          const question = askUserQuestion(event.report);
          if (question !== null) {
            // The agent wants the user's answer before continuing - pause,
            // then feed the answer into the SAME session (context kept).
            const answer = await promptUser(
              run,
              emitId,
              'question',
              question.question,
              question.options,
            );
            if (isTerminal(run.status)) {
              return false;
            }
            session.send(
              answer.note?.trim() ? answer.note : 'No answer - proceed with your best judgment.',
            );
            continue;
          }
          report = event.report;
          sawDone = true;
          break;
        } else if (event.type === 'error') {
          errorMessage = event.message;
          isQuotaError = event.isQuotaError === true;
          isAuthError = event.isAuthError === true;
          quotaRetryAt = event.retryAt;
          break;
        }
      }
    } catch (cause) {
      errorMessage = cause instanceof Error ? cause.message : String(cause);
    } finally {
      session.cancel();
      run.activeSessions.delete(session);
    }

    if (isTerminal(run.status)) {
      return false;
    }
    if (sawDone && report === undefined && agent.reportExample) {
      // The contract says this agent ends with a JSON report - treat a
      // missing one as a failed attempt (silent nulls starve downstream
      // steps and gates), and let the normal retry ask again.
      errorMessage = 'The agent did not end with the required JSON report';
      sawDone = false;
    }
    if (sawDone) {
      recordOutput(run.outputs, step, report ?? null);
      const reportIssues = reportShapeIssues(report, agent.reportExample);
      await run.deps.emit({
        type: 'step-completed',
        stepId: emitId,
        ...(report === undefined ? {} : { report }),
        ...(reportIssues.length > 0 ? { reportIssues } : {}),
      });
      if (options?.detached) {
        return true;
      }
      return run.handleBlockingAndAdvance(step, report ?? null);
    }
    const message = errorMessage ?? 'Engine stream ended without a result';
    await run.deps.emit({ type: 'step-failed', stepId: emitId, message, attempt });
    if (isQuotaError || isAuthError) {
      // Retrying now would just hit the same wall (a limit, or a missing login) -
      // stop here, regardless of attempt count or this branch's on_fail policy.
      await run.interruptForQuota(message, quotaRetryAt, isAuthError ? 'auth' : 'quota');
      return false;
    }
    if (attempt === AGENT_STEP_ATTEMPTS) {
      return run.stepFailure(
        `Step '${emitId}' failed after ${attempt} attempts: ${message}`,
        options?.soft,
      );
    }
  }
  return false;
}

function buildRunSpec(
  agent: AgentDefinition,
  step: AgentStep,
  context: TaskRunContext,
  outputs: Readonly<Record<string, unknown>>,
  feedbackNote: string | undefined,
  standards: string | undefined,
  mcpServers: readonly McpServerSpec[] = [],
  skills?: string,
): EngineRunSpec {
  const standardsSection = standards ? `\n\n# Project standards - follow these\n${standards}` : '';
  const skillsSection = skills ? `\n\n${skills}` : '';
  const env = stepEnvironment(context, step.secrets);
  return {
    systemPrompt:
      agent.prompt +
      standardsSection +
      skillsSection +
      commandPolicySection(agent.tools) +
      reportInstruction(agent.reportExample),
    userMessage: buildStepInput({
      workspacePath: context.workspacePath,
      isolated: context.isolated === true,
      inputNames: step.input,
      outputs,
      ...(feedbackNote ? { feedbackNote } : {}),
    }),
    model: step.model ?? agent.model,
    effort: step.effort ?? agent.effort,
    cwd: context.workspacePath,
    allowWrite: agent.tools.write !== 'off',
    allowNetwork: agent.tools.network !== 'off',
    commandAllowlist: agent.tools.commands === 'off' ? [] : agent.tools.commandAllowlist,
    ...(mcpServers.length > 0 ? { mcpServers } : {}),
    ...(env ? { env } : {}),
  };
}

/**
 * Soft validation of a delivered report against the declared shape: top-level
 * keys the contract names but the reply lacks. Extra keys are fine - agents
 * may add detail; missing ones are surfaced as a warning on the step, never a
 * failure (models legitimately omit empty optional fields).
 */
function reportShapeIssues(report: unknown, reportExample: string | undefined): string[] {
  if (!reportExample || typeof report !== 'object' || report === null) {
    return [];
  }
  let expected: unknown;
  try {
    expected = JSON.parse(reportExample);
  } catch {
    return [];
  }
  if (typeof expected !== 'object' || expected === null || Array.isArray(expected)) {
    return [];
  }
  const missing = Object.keys(expected).filter(
    (key) => !(key in (report as Record<string, unknown>)),
  );
  return missing.length > 0 ? [`report is missing declared fields: ${missing.join(', ')}`] : [];
}

/**
 * The agent's command policy, in its own words, so it never has to guess: the
 * allowlisted prefixes (compound lines are fine as long as every piece is
 * allowed or a free shell word), or the fact that commands are off. Anything
 * else pauses the run for a human - a cost the agent should avoid.
 */
function commandPolicySection(tools: AgentDefinition['tools']): string {
  if (tools.commands === 'off') {
    return '\n\n# Commands\n\nYou cannot run shell commands in this step. Work from the files and the inputs you were given.';
  }
  if (tools.commands === 'allowlist') {
    if (tools.commandAllowlist.length === 0) {
      return '\n\n# Commands\n\nNo shell commands are allowed in this step. Work from the files and the inputs you were given.';
    }
    const list = tools.commandAllowlist.map((prefix) => `\`${prefix}\``).join(', ');
    return `\n\n# Commands\n\nYou may run only these commands (prefix match): ${list}. Chaining them with \`;\`, \`&&\` or pipes is fine, as are \`cd\`, \`echo\`, \`head\`, \`tail\`, \`wc\`, \`sort\` and shell loops. Anything else stops the run and waits for a human to approve it - do not rely on that; if a command you need is missing, say so in your report instead.`;
  }
  return '';
}

/**
 * The report contract is system-owned: this tail, not the agent file's editable
 * prose, tells the model to end with the declared shape, so report parsing and
 * downstream step inputs keep working however prompts are edited.
 */
function reportInstruction(reportExample: string | undefined): string {
  if (!reportExample) {
    return '';
  }
  return `\n\nEnd your reply with exactly one fenced JSON report in exactly this shape:\n\`\`\`json\n${reportExample}\n\`\`\`\n\nIf you genuinely need the user's answer before you can proceed (a real decision only they can make - never routine confirmation), end your reply with this instead and wait:\n\`\`\`json\n{ "ask_user": "your question, concrete and answerable in one line", "options": ["your recommended answer", "a real alternative", "another"] }\n\`\`\`\nGive 2-4 options when the answers are enumerable, your recommendation FIRST; omit "options" for open questions. The user may always type their own answer. It arrives as the next user message; then continue and finish with the normal report.`;
}

/** Absolute workspace paths read like noise - show them relative, as a terminal would. */
function relativizeDetail(detail: string | undefined, workspacePath: string): string | undefined {
  if (!detail || !detail.startsWith(workspacePath)) {
    return detail;
  }
  const relative = detail.slice(workspacePath.length).replace(/^[/\\]/, '');
  return relative.length > 0 ? relative : '.';
}

/** A turn ending with {"ask_user": "...", "options": [...]} is a question, not a report. */
function askUserQuestion(
  report: unknown,
): { question: string; options?: readonly string[] } | null {
  if (typeof report !== 'object' || report === null) {
    return null;
  }
  const raw = report as Record<string, unknown>;
  const question = raw['ask_user'];
  if (typeof question !== 'string' || question.trim().length === 0) {
    return null;
  }
  const options = Array.isArray(raw['options'])
    ? raw['options']
        .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
        .slice(0, 6)
    : undefined;
  return {
    question: question.trim(),
    ...(options && options.length > 0 ? { options } : {}),
  };
}

/** What a run is about, for skills matching: every string input, longest first. */
function aboutText(inputs: Readonly<Record<string, unknown>>): string {
  return Object.values(inputs)
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .sort((left, right) => right.length - left.length)
    .join('\n');
}
