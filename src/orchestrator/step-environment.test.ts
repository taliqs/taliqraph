import type { WorkflowDefinition } from '../definitions/workflow/workflow-definition';
import { describe, expect, it } from 'vitest';
import { stepEnvironment } from './step-environment';
import { ScriptedEngine, context, done, featureDev, makeDeps } from './test-harness';
import { WorkflowRun } from './workflow-run';

describe('step environments', () => {
  it('hands a script and an agent the clean base plus only the secrets each lists', async () => {
    const workflow: WorkflowDefinition = {
      ...featureDev,
      secrets: [
        { name: 'GH_TOKEN', required: true },
        { name: 'JIRA_API_TOKEN', required: false },
      ],
      steps: [
        { kind: 'agent', id: 'history', agent: 'engineer', input: [], secrets: ['GH_TOKEN'] },
        { kind: 'script', id: 'post', command: 'github-post-review', secrets: ['GH_TOKEN'] },
        { kind: 'script', id: 'plain', command: 'echo ok' },
      ],
    };
    const engine = new ScriptedEngine([[done({ ok: true })]]);
    const { deps } = makeDeps(engine);
    const specs: Array<Readonly<Record<string, string>> | undefined> = [];
    const run = new WorkflowRun(
      workflow,
      {
        ...context,
        env: { PATH: '/usr/bin', HOME: '/home/me' },
        secrets: { GH_TOKEN: 'ghp_x', JIRA_API_TOKEN: 'jira_y' },
      },
      {
        ...deps,
        runScript: (spec) => {
          specs.push(spec.env);
          return Promise.resolve({ exitCode: 0, stdout: '{"ok":true}', stderr: '' });
        },
      },
    );
    await run.start();
    expect(run.currentStatus).toBe('completed');
    expect(engine.specs[0]?.env).toEqual({ PATH: '/usr/bin', HOME: '/home/me', GH_TOKEN: 'ghp_x' });
    expect(specs).toEqual([
      { PATH: '/usr/bin', HOME: '/home/me', GH_TOKEN: 'ghp_x' },
      { PATH: '/usr/bin', HOME: '/home/me' }, // lists nothing - sees no secret
    ]);
    // no env on the context = inherit the host's
    expect(stepEnvironment({ secrets: { GH_TOKEN: 'x' } }, ['GH_TOKEN'])).toBeUndefined();
  });
});
