import type { WorkflowDefinition } from '../definitions/workflow/workflow-definition';
import { describe, expect, it } from 'vitest';
import { ScriptedEngine, context, done, makeDeps } from './test-harness';
import { WorkflowRun } from './workflow-run';

describe('report contract enforcement', () => {
  const strictWorkflow: WorkflowDefinition = {
    name: 'strict-flow',
    title: 'Strict',
    scope: 'global',
    steps: [{ kind: 'agent', id: 'work', agent: 'strict', input: ['inputs.prompt'] }],
  };

  it('appends the standardized report instruction to the system prompt', async () => {
    const engine = new ScriptedEngine([[done({ summary: 'x', risks: [] })]]);
    const { deps } = makeDeps(engine);
    await new WorkflowRun(strictWorkflow, context, deps).start();
    expect(engine.specs[0]?.systemPrompt).toContain('You are strict.');
    expect(engine.specs[0]?.systemPrompt).toContain(
      'End your reply with exactly one fenced JSON report in exactly this shape:',
    );
    expect(engine.specs[0]?.systemPrompt).toContain('"risks"');
  });

  it('treats a missing required report as a failed attempt and retries', async () => {
    const engine = new ScriptedEngine([[done()], [done({ summary: 'ok', risks: [] })]]);
    const { deps, events } = makeDeps(engine);
    const run = new WorkflowRun(strictWorkflow, context, deps);
    await run.start();

    expect(run.currentStatus).toBe('completed');
    const failure = events.find((event) => event.type === 'step-failed');
    expect(failure).toMatchObject({
      message: 'The agent did not end with the required JSON report',
      attempt: 1,
    });
    expect(events.filter((event) => event.type === 'step-completed')).toHaveLength(1);
  });

  it('fails the run when the report never arrives', async () => {
    const engine = new ScriptedEngine([[done()], [done()]]);
    const { deps, events } = makeDeps(engine);
    const run = new WorkflowRun(strictWorkflow, context, deps);
    await run.start();

    expect(run.currentStatus).toBe('failed');
    const runFailed = events.find((event) => event.type === 'run-failed');
    expect(runFailed && 'message' in runFailed && runFailed.message).toContain(
      'did not end with the required JSON report',
    );
  });

  it('flags declared fields the delivered report lacks, without failing', async () => {
    const engine = new ScriptedEngine([[done({ summary: 'only this' })]]);
    const { deps, events } = makeDeps(engine);
    const run = new WorkflowRun(strictWorkflow, context, deps);
    await run.start();

    expect(run.currentStatus).toBe('completed');
    const completed = events.find((event) => event.type === 'step-completed');
    expect(completed && 'reportIssues' in completed && completed.reportIssues).toEqual([
      'report is missing declared fields: risks',
    ]);
  });

  it('agents without a report contract may finish with no report', async () => {
    const noReport: WorkflowDefinition = {
      ...strictWorkflow,
      name: 'loose-flow',
      steps: [{ kind: 'agent', id: 'work', agent: 'engineer', input: ['inputs.prompt'] }],
    };
    const engine = new ScriptedEngine([[done()]]);
    const { deps, events } = makeDeps(engine);
    const run = new WorkflowRun(noReport, context, deps);
    await run.start();
    expect(run.currentStatus).toBe('completed');
    expect(events.some((event) => event.type === 'step-failed')).toBe(false);
  });
});
