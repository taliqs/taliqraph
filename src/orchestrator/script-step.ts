import type { ScriptDefinition } from '../definitions/script/script-definition';
import type { ScriptStep } from '../definitions/workflow/workflow-step';
import { DEFAULT_SCRIPT_TIMEOUT_MINUTES } from '../definitions/script/script-definition';
import { collectStepInputs } from './build-step-input';
import { recordOutput } from './output-keys';
import { stepEnvironment } from './step-environment';
import type { ScriptRunSpec, WorkflowRun } from './workflow-run';

const SCRIPT_OUTPUT_CAP = 4_000;

export async function runScriptStep(
  run: WorkflowRun,
  step: ScriptStep,
  options?: { emitPrefix?: string; soft?: boolean },
): Promise<boolean> {
  const emitId = options?.emitPrefix ? `${options.emitPrefix}/${step.id}` : step.id;
  run.bumpRunCount(step.id);
  await run.deps.emit({
    type: 'step-started',
    stepId: emitId,
    stepKind: 'script',
    attempt: 1,
    ...((step.input ?? []).length > 0 ? { input: step.input } : {}),
  });
  // `script: <name>` runs the definition when one exists; anything else is a shell command
  const definition = run.deps.resolveScript?.(step.command);
  const inputs = scriptInputs(run, step, definition);
  const timeoutMs = (definition?.timeoutMinutes ?? DEFAULT_SCRIPT_TIMEOUT_MINUTES) * 60_000;
  const env = stepEnvironment(run.context, step.secrets);
  const spec: ScriptRunSpec = {
    ...(definition ? { definition } : { command: step.command }),
    inputs,
    timeoutMs,
    ...(env ? { env } : {}),
  };
  const callId = `script:${emitId}:${run.runCounts.get(step.id) ?? 1}`;
  await run.deps.emit({
    type: 'agent-tool-call',
    stepId: emitId,
    callId,
    toolName: 'Script',
    detail: definition ? `${definition.name} → ${definition.run}` : step.command,
    input: { command: step.command, inputs: Object.keys(inputs) },
  });
  try {
    const result = await run.deps.runScript(spec, run.context);
    await run.deps.emit({
      type: 'agent-tool-result',
      stepId: emitId,
      callId,
      isError: result.exitCode !== 0,
    });
    if (result.exitCode !== 0) {
      const tail = capText(result.stderr || result.stdout, 2_000);
      const message = `Command failed (exit ${result.exitCode})${tail ? `:\n${tail}` : ''}`;
      await run.deps.emit({ type: 'step-failed', stepId: emitId, message, attempt: 1 });
      return run.stepFailure(
        `Script step '${step.id}' failed (exit ${result.exitCode})`,
        options?.soft,
      );
    }
    const report = result.report !== undefined ? result.report : parseScriptOutput(result.stdout);
    recordOutput(run.outputs, step, report);
    const reportIssues = scriptReportIssues(report, definition);
    await run.deps.emit({
      type: 'step-completed',
      stepId: emitId,
      report,
      ...(reportIssues.length > 0 ? { reportIssues } : {}),
    });
    return true;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    await run.deps.emit({ type: 'step-failed', stepId: emitId, message, attempt: 1 });
    return run.stepFailure(`Script step '${step.id}' failed: ${message}`, options?.soft);
  }
}

/** The `with:` params (`$ref` resolved) join the positional inputs under their own keys. */
function scriptInputs(
  run: WorkflowRun,
  step: ScriptStep,
  definition: ScriptDefinition | undefined,
): Readonly<Record<string, unknown>> {
  const positional = collectStepInputs(
    step.input ?? [],
    run.readable(),
    definition?.inputs.map((input) => input.name) ?? [],
  );
  return step.params ? { ...positional, ...run.resolveParams(step.params) } : positional;
}

/**
 * A script's report: the whole stdout when it is JSON, else the LAST line that
 * parses as JSON (everything before it is just logging), else the tail as text.
 */
function parseScriptOutput(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    return { ok: true };
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    // not one JSON document - look for a trailing JSON line
  }
  const lines = trimmed.split('\n').map((line) => line.trim());
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? '';
    if (line.startsWith('{') || line.startsWith('[')) {
      try {
        return JSON.parse(line);
      } catch {
        // keep looking
      }
    }
  }
  return { output: capText(trimmed, SCRIPT_OUTPUT_CAP) };
}

export function capText(text: string, cap: number): string {
  return text.length <= cap ? text : `${text.slice(-cap)}\n… (truncated)`;
}

/**
 * What is wrong with what the script printed: text where a report was meant
 * (the raw output is kept under `output`, and every reference into it reads as
 * missing), or a report without the fields the script declares.
 */
function scriptReportIssues(report: unknown, definition: ScriptDefinition | undefined): string[] {
  if (typeof report !== 'object' || report === null) {
    return [];
  }
  const fields = report as Record<string, unknown>;
  if (Object.keys(fields).length === 1 && typeof fields['output'] === 'string') {
    return ['printed no JSON report - print JSON.stringify({ ... }) so steps can read its fields'];
  }
  let expected: unknown;
  try {
    expected = definition?.reportExample ? JSON.parse(definition.reportExample) : undefined;
  } catch {
    return [];
  }
  if (typeof expected !== 'object' || expected === null || Array.isArray(expected)) {
    return [];
  }
  const missing = Object.keys(expected).filter((key) => !(key in fields));
  return missing.length > 0 ? [`report is missing declared fields: ${missing.join(', ')}`] : [];
}
