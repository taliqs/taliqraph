import { describe, expect, it } from 'vitest';
import { parseEnvPairs } from './env-pairs';

describe('parseEnvPairs', () => {
  it('splits on the first = and keeps the rest verbatim', () => {
    expect(parseEnvPairs(['GH_TOKEN=abc=def', 'EMPTY='])).toEqual({
      GH_TOKEN: 'abc=def',
      EMPTY: '',
    });
  });

  it('rejects names that are not identifiers and pairs without a value', () => {
    expect(() => parseEnvPairs(['9X=1'])).toThrow(/identifier/);
    expect(() => parseEnvPairs(['GH_TOKEN'])).toThrow(/no value/);
  });
});
