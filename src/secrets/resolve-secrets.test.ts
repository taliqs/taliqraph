import type { WorkflowDefinition } from '../definitions/workflow/workflow-definition';
import { describe, expect, it } from 'vitest';
import { declaredSecretsOf, resolveSecrets } from './resolve-secrets';

describe('resolveSecrets', () => {
  it('takes what the host provides, skips empty values, and lists only required names that are absent', () => {
    const result = resolveSecrets(
      [
        { name: 'GH_TOKEN', required: true },
        { name: 'JIRA_API_TOKEN', required: true },
        { name: 'SLACK_TOKEN', required: false },
        { name: 'MISSING', required: true },
      ],
      { GH_TOKEN: 'from-env', JIRA_API_TOKEN: '', SLACK_TOKEN: undefined },
    );
    expect(result.values).toEqual({ GH_TOKEN: 'from-env' });
    expect(result.missing).toEqual(['JIRA_API_TOKEN', 'MISSING']);
  });
});

describe('declaredSecretsOf', () => {
  const flow = (
    name: string,
    secrets: WorkflowDefinition['secrets'],
    children: string[] = [],
  ): WorkflowDefinition => ({
    name,
    title: name,
    scope: 'global',
    ...(secrets ? { secrets } : {}),
    steps: children.map((child) => ({ kind: 'workflow', id: child, workflow: child })),
  });

  it('walks sub-workflows once each, required winning over optional', () => {
    const workflows: Record<string, WorkflowDefinition> = {
      main: flow('main', [{ name: 'GH_TOKEN', required: false }], ['child', 'child']),
      child: flow(
        'child',
        [
          { name: 'GH_TOKEN', required: true },
          { name: 'JIRA', required: false },
        ],
        ['main'],
      ),
    };
    expect(declaredSecretsOf(workflows['main']!, (name) => workflows[name])).toEqual([
      { name: 'GH_TOKEN', required: true },
      { name: 'JIRA', required: false },
    ]);
    expect(declaredSecretsOf(flow('bare', undefined), () => undefined)).toEqual([]);
  });
});
