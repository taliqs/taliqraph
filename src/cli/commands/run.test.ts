import { describe, expect, it } from 'vitest';
import { outputLines } from './run';

describe('outputLines', () => {
  it('shows every value the run handed back, and leaves the summary out', () => {
    expect(
      outputLines({ foo: '', 'approved?': true, items: ['a', 'b'], _summary: 'done' }),
    ).toEqual(['  foo: ', '  approved?: true', '  items: ["a","b"]']);
  });

  it('flattens and cuts a long value', () => {
    const line = outputLines({ text: `a\nb${'c'.repeat(200)}` }, 20)[0] ?? '';
    expect(line.startsWith('  text: a b')).toBe(true);
    expect(line.endsWith('\u2026')).toBe(true);
    expect(line).toHaveLength('  text: '.length + 20);
  });

  it('says nothing when there is nothing but a summary', () => {
    expect(outputLines({ _summary: 'done' })).toEqual([]);
    expect(outputLines(undefined)).toEqual([]);
  });
});
