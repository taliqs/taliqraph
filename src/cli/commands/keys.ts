/** What a keystroke means to a prompt; anything printable arrives as `text`. */
export type Key =
  | { readonly kind: 'up' }
  | { readonly kind: 'down' }
  | { readonly kind: 'enter' }
  | { readonly kind: 'backspace' }
  | { readonly kind: 'interrupt' }
  | { readonly kind: 'text'; readonly value: string };

const ESCAPE = String.fromCharCode(0x1b);
const ARROWS: Readonly<Record<string, 'up' | 'down'>> = {
  [`${ESCAPE}[A`]: 'up',
  [`${ESCAPE}OA`]: 'up',
  [`${ESCAPE}[B`]: 'down',
  [`${ESCAPE}OB`]: 'down',
};
/**
 * How long the escape sequence at the start of `rest` is, so an unknown one is
 * skipped whole instead of arriving as text: a CSI sequence runs to its final
 * letter, SS3 takes one more character, anything else is the escape and what
 * follows it.
 */
function sequenceLength(rest: string): number {
  if (rest.length < 2) {
    return 1;
  }
  if (rest[1] === '[') {
    let at = 2;
    while (at < rest.length && /[0-9;?]/.test(rest[at] ?? '')) {
      at += 1;
    }
    return Math.min(at + 1, rest.length);
  }
  return rest[1] === 'O' ? Math.min(3, rest.length) : 2;
}

/**
 * One terminal chunk as the keys it holds. A chunk can carry several (a held
 * arrow, a paste), so every prompt handles a list.
 */
export function decodeKeys(chunk: string): Key[] {
  const keys: Key[] = [];
  let text = '';
  const flush = (): void => {
    if (text.length > 0) {
      keys.push({ kind: 'text', value: text });
      text = '';
    }
  };
  let at = 0;
  while (at < chunk.length) {
    const arrow = ARROWS[chunk.slice(at, at + 3)];
    if (arrow) {
      flush();
      keys.push({ kind: arrow });
      at += 3;
      continue;
    }
    const code = chunk.codePointAt(at) ?? 0;
    const character = String.fromCodePoint(code);
    if (code === 0x0d || code === 0x0a) {
      flush();
      keys.push({ kind: 'enter' });
    } else if (code === 0x7f || code === 0x08) {
      flush();
      keys.push({ kind: 'backspace' });
    } else if (code === 0x03) {
      flush();
      keys.push({ kind: 'interrupt' });
    } else if (code === 0x1b) {
      flush();
      at += sequenceLength(chunk.slice(at));
      continue;
    } else if (code >= 0x20) {
      text += character;
    }
    at += character.length;
  }
  flush();
  return keys;
}
