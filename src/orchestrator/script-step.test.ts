import type { WorkflowDefinition } from '../definitions/workflow/workflow-definition';
import { describe, expect, it } from 'vitest';
import { context, makeDeps, ScriptedEngine } from './test-harness';
import { WorkflowRun } from './workflow-run';

const flow = (): WorkflowDefinition => ({
  name: 'reports',
  title: 'Reports',
  scope: 'global',
  steps: [{ kind: 'script', id: 'do-stuff', command: 'do-stuff' }],
});

/** Runs the one script step with whatever it prints, and hands back the completion event. */
async function completedWith(
  stdout: string,
): Promise<Extract<ReturnType<typeof makeDeps>['events'][number], { type: 'step-completed' }>> {
  const { deps, events } = makeDeps(new ScriptedEngine([]));
  const run = new WorkflowRun(flow(), context, {
    ...deps,
    runScript: () => Promise.resolve({ exitCode: 0, stdout, stderr: '' }),
  });
  await run.start();
  const completed = events.find(
    (event) => event.type === 'step-completed' && event.stepId === 'do-stuff',
  );
  if (!completed || completed.type !== 'step-completed') {
    throw new Error('the script step did not complete');
  }
  return completed;
}

describe('a script step reports what it printed', () => {
  it('says so when the script printed text instead of a JSON report', async () => {
    // `console.log({ value: 3 })` prints a JavaScript object, which is not JSON
    const completed = await completedWith('Doing stuff\n{ value: 3, options: [ 1, 2, 4 ] }');
    expect(completed.report).toEqual({
      output: 'Doing stuff\n{ value: 3, options: [ 1, 2, 4 ] }',
    });
    expect(completed.reportIssues?.join(' ')).toContain('printed no JSON report');
  });

  it('takes the last JSON line and says nothing', async () => {
    const completed = await completedWith('working…\n{"value":3,"options":[1,2,4]}');
    expect(completed.report).toEqual({ value: 3, options: [1, 2, 4] });
    expect(completed.reportIssues).toBeUndefined();
  });

  it('names the declared fields a report leaves out', async () => {
    const { deps, events } = makeDeps(new ScriptedEngine([]));
    const run = new WorkflowRun(
      { ...flow(), steps: [{ kind: 'script', id: 'do-stuff', command: 'do-stuff' }] },
      context,
      {
        ...deps,
        resolveScript: () => ({
          name: 'do-stuff',
          title: 'Do stuff',
          description: 'd',
          run: 'node run.mjs',
          scope: 'global',
          inputs: [],
          timeoutMinutes: 1,
          reportExample: '{"value":3,"options":[1]}',
        }),
        runScript: () => Promise.resolve({ exitCode: 0, stdout: '{"value":3}', stderr: '' }),
      },
    );
    await run.start();
    const completed = events.find(
      (event) => event.type === 'step-completed' && event.stepId === 'do-stuff',
    );
    expect(completed?.type === 'step-completed' && completed.reportIssues?.join(' ')).toContain(
      'missing declared fields: options',
    );
  });
});
