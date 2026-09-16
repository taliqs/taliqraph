import { describe, expect, it } from 'vitest';
import { capToolInput } from './cap-tool-input';

describe('capToolInput', () => {
  it('passes small inputs through unchanged', () => {
    expect(capToolInput({ command: 'npm test', timeout: 60 })).toEqual({
      command: 'npm test',
      timeout: 60,
    });
  });

  it('truncates long strings with a visible marker', () => {
    const capped = capToolInput({ content: 'x'.repeat(5_000) }) as { content: string };
    expect(capped.content.length).toBeLessThan(2_100);
    expect(capped.content).toContain('[+3000 chars]');
  });

  it('caps huge structures to a preview blob', () => {
    const huge: Record<string, string> = {};
    for (let index = 0; index < 40; index += 1) {
      huge[`key${index}`] = 'y'.repeat(1_500);
    }
    const capped = capToolInput(huge) as { note?: string };
    expect(capped.note).toContain('truncated');
  });

  it('keeps undefined as undefined', () => {
    expect(capToolInput(undefined)).toBeUndefined();
  });
});
