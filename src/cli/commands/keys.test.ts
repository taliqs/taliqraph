import { describe, expect, it } from 'vitest';
import { decodeKeys } from './keys';

describe('decodeKeys', () => {
  it('reads arrows, Enter, Backspace and Ctrl+C', () => {
    expect(decodeKeys('\u001B[A\u001B[B\r\u007F\u0003')).toEqual([
      { kind: 'up' },
      { kind: 'down' },
      { kind: 'enter' },
      { kind: 'backspace' },
      { kind: 'interrupt' },
    ]);
    expect(decodeKeys('\u001BOA')).toEqual([{ kind: 'up' }]);
  });

  it('collects printable text, emoji included, and splits it around the keys between', () => {
    expect(decodeKeys('ab')).toEqual([{ kind: 'text', value: 'ab' }]);
    expect(decodeKeys('a\u001B[Bb')).toEqual([
      { kind: 'text', value: 'a' },
      { kind: 'down' },
      { kind: 'text', value: 'b' },
    ]);
    expect(decodeKeys('h\u{1F600}')).toEqual([{ kind: 'text', value: 'h\u{1F600}' }]);
  });

  it('skips an unknown escape sequence whole and drops other control characters', () => {
    expect(decodeKeys('\u001B[200~x')).toEqual([{ kind: 'text', value: 'x' }]);
    expect(decodeKeys('\u0000a\u0001')).toEqual([{ kind: 'text', value: 'a' }]);
    expect(decodeKeys('')).toEqual([]);
  });
});
