import { describe, expect, it } from 'vitest';
import { parseScriptDefinition } from './parse-script-definition';
import { serializeScriptDefinition } from './serialize-script-definition';

const FULL = `name: run-tests
title: Run tests
description: Runs the project's tests and reports pass/fail counts.
run: node run.mjs --reporter json
inputs:
  - implementation
  - name: plan
    required: false
    description: the approved plan, when there is one
report:
  passed: 12
  failed: 0
  blocking: false
timeout_minutes: 20
`;

describe('parseScriptDefinition', () => {
  it('parses a full manifest - inputs in both forms, the report as JSON text, the folder it came from', () => {
    const parsed = parseScriptDefinition(FULL, 'global', {
      dir: '/home/me/.taliqraph/scripts/run-tests',
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toEqual({
      name: 'run-tests',
      title: 'Run tests',
      description: "Runs the project's tests and reports pass/fail counts.",
      run: 'node run.mjs --reporter json',
      inputs: [
        { name: 'implementation', required: true },
        { name: 'plan', required: false, description: 'the approved plan, when there is one' },
      ],
      reportExample: JSON.stringify({ passed: 12, failed: 0, blocking: false }, null, 2),
      timeoutMinutes: 20,
      scope: 'global',
      dir: '/home/me/.taliqraph/scripts/run-tests',
    });
  });

  it('defaults: no inputs, no report, ten minutes', () => {
    const parsed = parseScriptDefinition(
      'name: lint\ndescription: Lints.\nrun: pnpm lint\n',
      'project',
    );
    expect(parsed.ok && parsed.value).toEqual({
      name: 'lint',
      description: 'Lints.',
      run: 'pnpm lint',
      inputs: [],
      timeoutMinutes: 10,
      scope: 'project',
    });
  });

  it('rejects a bad name, a missing run, and non-YAML - with the issues', () => {
    const badName = parseScriptDefinition('name: Run Tests\ndescription: x\nrun: y\n', 'global');
    expect(!badName.ok && badName.error.issues.join(' ')).toContain('name');
    const noRun = parseScriptDefinition('name: ok\ndescription: x\n', 'global');
    expect(!noRun.ok && noRun.error.issues.join(' ')).toContain('run');
    const notYaml = parseScriptDefinition('name: [\n', 'global');
    expect(!notYaml.ok && notYaml.error.message).toContain('not valid YAML');
  });

  it('round-trips through serializeScriptDefinition', () => {
    const parsed = parseScriptDefinition(FULL, 'global');
    if (!parsed.ok) throw new Error(parsed.error.message);
    const again = parseScriptDefinition(serializeScriptDefinition(parsed.value), 'global');
    expect(again.ok && again.value).toEqual(parsed.value);
    // defaults are left out of the file
    const minimal = parseScriptDefinition(
      'name: lint\ndescription: Lints.\nrun: pnpm lint\n',
      'global',
    );
    if (!minimal.ok) throw new Error(minimal.error.message);
    expect(serializeScriptDefinition(minimal.value)).toBe(
      'name: lint\ndescription: Lints.\nrun: pnpm lint\n',
    );
  });
});
