import { describe, expect, it } from 'vitest';
import { parseWorkflowDefinition } from './parse-workflow-definition';
import { serializeWorkflowDefinition } from './serialize-workflow-definition';
import type { WorkflowDefinition } from './workflow-definition';

const richWorkflow: WorkflowDefinition = {
  name: 'feature-dev',
  title: 'Feature Dev',
  scope: 'global',
  steps: [
    {
      kind: 'agent',
      id: 'investigate',
      agent: 'investigator',
      input: ['task'],
      output: 'findings',
    },
    {
      kind: 'agent',
      id: 'implement',
      agent: 'software-engineer',
      model: 'opus-5',
      effort: 'high',
      input: ['findings'],
    },
    { kind: 'gate', gate: 'approve', id: 'approve', show: ['findings', 'diff'], editable: true },
    {
      kind: 'workflow',
      id: 'review',
      workflow: 'review-loop',
      onBlocking: { gotoStepId: 'implement', maxLoops: 2, then: 'gate' },
    },
    {
      kind: 'script',
      id: 'open-pr',
      command: 'github-create-pr',
      params: { draft: true },
    },
  ],
};

const minimalWorkflow: WorkflowDefinition = {
  name: 'tiny',
  title: 'Tiny',
  scope: 'global',
  steps: [{ kind: 'agent', id: 'work', agent: 'helper', input: [] }],
};

describe('serializeWorkflowDefinition', () => {
  it('roundtrips a workflow with every step kind through the parser unchanged', () => {
    const parsed = parseWorkflowDefinition(serializeWorkflowDefinition(richWorkflow), 'global');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value).toEqual(richWorkflow);
    }
  });

  it('roundtrips a minimal workflow and omits empty optional fields', () => {
    const source = serializeWorkflowDefinition(minimalWorkflow);
    expect(source).not.toContain('match:');
    expect(source).not.toContain('extends:');
    const parsed = parseWorkflowDefinition(source, 'global');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value).toEqual(minimalWorkflow);
    }
  });

  it('keeps the extends reference verbatim', () => {
    const extended: WorkflowDefinition = { ...minimalWorkflow, extendsName: 'feature-dev' };
    expect(serializeWorkflowDefinition(extended)).toContain('extends: feature-dev');
  });

  it('roundtrips script steps, agent loop-backs, and run policy', () => {
    const flow: WorkflowDefinition = {
      name: 'review-heavy',
      title: 'Review Heavy',
      scope: 'global',
      steps: [
        { kind: 'agent', id: 'implement', agent: 'software-engineer', input: ['task'] },
        {
          kind: 'script',
          id: 'tests',
          command: 'pnpm test',
          output: 'testResults',
          when: { maxRuns: 2 },
        },
        {
          kind: 'agent',
          id: 'security-scan',
          agent: 'security-reviewer',
          input: ['testResults'],
          onBlocking: { gotoStepId: 'implement', maxLoops: 2, then: 'gate' },
          when: { maxRuns: 1 },
        },
      ],
    };
    const source = serializeWorkflowDefinition(flow);
    expect(source).toContain('script: pnpm test');
    expect(source).toContain('max_runs: 1');
    const parsed = parseWorkflowDefinition(source, 'global');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value).toEqual(flow);
    }
  });
});
