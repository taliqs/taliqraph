import { parseWorkflowDefinition } from '../../definitions/workflow/parse-workflow-definition';
import { isOk } from '../../shared/types/result';
import { describe, expect, it } from 'vitest';
import { Output } from '../output';
import { failureLine } from './render-event';
import { renderWorkflow } from './render-workflow';

const SOURCE = [
  'name: demo',
  'title: Demo',
  'description: A tiny pipeline.',
  'match: [demo]',
  'steps:',
  '  - id: look',
  '    agent: investigator',
  '    input: [task]',
  '    output: findings',
  '  - id: check',
  '    gate: approve',
  '    show: findings',
  '  - id: decide',
  '    if: findings.ok',
  '    equals: true',
  '    then: look',
  '',
].join('\n');

describe('renderWorkflow', () => {
  it('lists every step with its kind, inputs, outputs and jumps', () => {
    const parsed = parseWorkflowDefinition(SOURCE, 'project');
    expect(isOk(parsed)).toBe(true);
    if (!isOk(parsed)) {
      return;
    }
    const lines = renderWorkflow(parsed.value);
    expect(lines[0]).toBe('demo - Demo');
    expect(lines).toContain('look  agent investigator ← task → findings');
    expect(lines).toContain('check  gate - shows findings');
    expect(lines.some((line) => line.startsWith('decide  if findings.ok'))).toBe(true);
    expect(lines).toContain('  then → look');
  });
});

describe('failureLine', () => {
  const plain = new Output({ json: false, quiet: false, color: false });
  const nodeCrash = [
    'Command failed (exit 1):',
    'file:///tmp/pkg/scripts/do-stuff/run.mjs:9',
    'return 2;',
    '^^^^^^',
    '',
    'SyntaxError: Illegal return statement',
    '    at compileSourceTextModule (node:internal/modules/esm/utils:346:16)',
    '    at ModuleLoader.moduleStrategy (node:internal/modules/esm/translators:107:18)',
  ].join('\n');

  it('keeps what failed and the error, and drops the stack', () => {
    expect(failureLine(nodeCrash, false, plain)).toBe(
      'Command failed (exit 1): SyntaxError: Illegal return statement (--verbose for the full output)',
    );
  });

  it('says everything when asked', () => {
    expect(failureLine(nodeCrash, true, plain)).toBe(nodeCrash);
  });

  it('leaves a one-line failure alone', () => {
    expect(failureLine('Command failed (exit 2)', false, plain)).toBe('Command failed (exit 2)');
  });
});
