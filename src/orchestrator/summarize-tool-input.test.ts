import { describe, expect, it } from 'vitest';
import { summarizeToolInput } from './summarize-tool-input';

describe('summarizeToolInput', () => {
  it('prefers the command for shell-style tools', () => {
    expect(summarizeToolInput({ command: 'npm test -- --run', description: 'Run tests' })).toBe(
      'npm test -- --run',
    );
  });

  it('falls back through file paths and patterns', () => {
    expect(summarizeToolInput({ file_path: 'src/drm/session.ts' })).toBe('src/drm/session.ts');
    expect(summarizeToolInput({ pattern: 'retry' })).toBe('retry');
  });

  it('flattens whitespace and truncates long values', () => {
    const detail = summarizeToolInput({ command: `echo ${'x'.repeat(300)}\n\nmore` });
    expect(detail?.length).toBeLessThanOrEqual(141);
    expect(detail?.endsWith('…')).toBe(true);
    expect(detail?.includes('\n')).toBe(false);
  });

  it('returns undefined for unknown shapes', () => {
    expect(summarizeToolInput({ content: 'big blob' })).toBeUndefined();
    expect(summarizeToolInput('nope')).toBeUndefined();
    expect(summarizeToolInput(null)).toBeUndefined();
  });
});
