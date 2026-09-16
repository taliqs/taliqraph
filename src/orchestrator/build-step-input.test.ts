import { describe, expect, it } from 'vitest';
import { buildStepInput, collectStepInputs } from './build-step-input';

describe('buildStepInput', () => {
  it('renders a declared text input as prose and other outputs as JSON', () => {
    const input = buildStepInput({
      inputNames: ['inputs.prompt', 'inputs.count', 'findings'],
      outputs: {
        inputs: { prompt: 'Fix the bug.', count: 3 },
        findings: { rootCause: 'timer leak' },
      },
    });
    expect(input).toContain('# inputs.prompt\nFix the bug.');
    expect(input).toContain('# inputs.count\n```json\n3\n```');
    expect(input).toContain('# findings');
    expect(input).toContain('"rootCause": "timer leak"');
  });

  it('resolves dotted references into a field, including length', () => {
    const input = buildStepInput({
      inputNames: [
        'review.bug-hunt.findings',
        'review.bug-hunt.findings.length',
        'review.summary.length',
      ],
      outputs: {
        review: {
          'bug-hunt': { findings: [{ file: 'a.ts' }, { file: 'b.ts' }] },
          summary: 'looks fine',
        },
      },
    });
    expect(input).toContain('# review.bug-hunt.findings\n```json\n[\n  {\n    "file": "a.ts"');
    expect(input).toContain('# review.bug-hunt.findings.length\n```json\n2\n```');
    expect(input).toContain('# review.summary.length\n```json\n10\n```');
  });

  it("'all' hands over every output so far, once each, in production order - never the inputs or run roots", () => {
    const findings = { rootCause: 'timer leak' };
    const input = buildStepInput({
      inputNames: ['all'],
      // id and alias point at the same report; inputs, run state and for_each slots are not steps
      outputs: {
        inputs: { prompt: 'x' },
        investigate: findings,
        findings,
        plan: { steps: [] },
        run: { loops: {} },
        '__foreach:x:1': 1,
      },
    });
    expect(input.match(/^# .*$/gm)).toEqual(['# investigate', '# plan']);
    expect(input).not.toContain('# run');
  });

  it('marks missing outputs instead of failing', () => {
    const input = buildStepInput({ inputNames: ['plan'], outputs: {} });
    expect(input).toContain('# plan\n(not available)');
  });

  it('appends feedback notes for re-runs', () => {
    const input = buildStepInput({
      inputNames: [],
      outputs: {},
      feedbackNote: 'Plan is too big - split it.',
    });
    expect(input).toContain('# Feedback on the previous attempt');
    expect(input).toContain('split it');
  });
});

describe('collectStepInputs', () => {
  it('is positional under args, named by parameter or reference, and always carries the declared inputs', () => {
    const outputs = { inputs: { prompt: 'Fix it', pr: { number: 4 } }, findings: { risky: true } };
    expect(collectStepInputs(['findings', 'inputs.pr', 'nope'], outputs, ['findings'])).toEqual({
      inputs: outputs.inputs,
      args: [{ risky: true }, { number: 4 }, null],
      findings: { risky: true },
      'inputs.pr': { number: 4 },
      nope: null,
    });
    expect(collectStepInputs([], {})).toEqual({ inputs: {}, args: [] });
  });
});
