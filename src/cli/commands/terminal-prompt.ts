import type { Key } from './keys';
import { decodeKeys } from './keys';
import type { MenuModel } from './menu-options';
import type { GatePrompt, MenuPick } from './terminal-gate';
import { GateInterrupted } from './terminal-gate';

const ESCAPE = String.fromCharCode(0x1b);
const HIDE_CURSOR = `${ESCAPE}[?25l`;
const SHOW_CURSOR = `${ESCAPE}[?25h`;

type Tone = 'accent' | 'dim';
interface Line {
  readonly text: string;
  readonly tone?: Tone;
}

/** Ends the live frame: one of these restores the terminal and answers the caller. */
interface Settle<T> {
  resolve(value: T): void;
  reject(cause: Error): void;
}

/** One frame line, cut to the terminal's width (80 when it reports none) before any colour is added to it. */
function paint(line: Line, columns: number, colour: boolean): string {
  const width = Math.max(20, columns - 1);
  const text = line.text.length > width ? `${line.text.slice(0, width - 1)}…` : line.text;
  if (!colour || !line.tone) {
    return text;
  }
  return `${ESCAPE}[${line.tone === 'accent' ? '36' : '2'}m${text}${ESCAPE}[0m`;
}

/**
 * Draws a frame, redraws it in place on every keystroke, and erases it once the
 * prompt settles - the feed keeps the record of what was asked and answered.
 */
function live<T>(
  input: NodeJS.ReadStream,
  output: NodeJS.WriteStream,
  frame: () => readonly Line[],
  handle: (key: Key, settle: Settle<T>, redraw: () => void) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const colour = output.isTTY === true && !process.env['NO_COLOR'];
    const wasRaw = input.isRaw === true;
    let painted = 0;
    const erase = (): string => (painted > 0 ? `${ESCAPE}[${painted}A${ESCAPE}[0J` : '');
    const draw = (): void => {
      const lines = frame().map((line) => paint(line, output.columns || 80, colour));
      output.write(`${erase()}${lines.map((line) => `${line}\n`).join('')}`);
      painted = lines.length;
    };
    const stop = (): void => {
      output.write(`${erase()}${SHOW_CURSOR}`);
      painted = 0;
      input.off('data', onData);
      input.setRawMode?.(wasRaw);
      input.pause();
    };
    const settle: Settle<T> = {
      resolve: (value) => {
        stop();
        resolve(value);
      },
      reject: (cause) => {
        stop();
        reject(cause);
      },
    };
    const onData = (chunk: string): void => {
      for (const key of decodeKeys(chunk)) {
        handle(key, settle, draw);
      }
    };
    input.setRawMode?.(true);
    input.setEncoding('utf8');
    input.resume();
    input.on('data', onData);
    output.write(HIDE_CURSOR);
    draw();
  });
}

/**
 * The menu as two groups: the entries to tick, numbered so a digit jumps to
 * one, then the exits that answer the gate, picked with the arrows.
 */
function menuFrame(menu: MenuModel, selected: number): Line[] {
  const items = menu.options.filter((option) => option.kind === 'item');
  const numbered = items.length > 0 ? 'item' : 'exit';
  const lines: Line[] = [
    { text: menu.title, tone: 'accent' },
    ...menu.body.map((text) => ({ text })),
    ...(menu.body.length > 0 ? [{ text: '' }] : []),
  ];
  let number = 0;
  menu.options.forEach((option, index) => {
    if (index > 0 && option.kind !== menu.options[index - 1]?.kind) {
      lines.push({ text: '' });
    }
    const mark = index === selected ? '\u276F' : ' ';
    const badge = option.kind === numbered ? `${(number += 1)}. ` : '   ';
    lines.push({
      text: `${mark} ${badge}${option.label}`,
      ...(index === selected ? { tone: 'accent' as const } : {}),
    });
  });
  const jump = number > 1 ? ` \u00B7 1-${number} jump` : '';
  lines.push({
    text:
      items.length > 0
        ? `\u2191\u2193 move \u00B7 Space tick \u00B7 Enter pick \u00B7 d dismiss${jump} \u00B7 Ctrl+C stop the run`
        : `\u2191\u2193 select \u00B7 Enter confirm${jump} \u00B7 Ctrl+C stop the run`,
    tone: 'dim',
  });
  return lines;
}

/**
 * The GatePrompt on this terminal: arrows move, Enter or Space picks, `d`
 * dismisses, a digit jumps and picks, Ctrl+C stops the run.
 */
export function terminalPrompt(
  input: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WriteStream = process.stdout,
): GatePrompt {
  return {
    menu: (menu) => {
      let selected = menu.selected;
      const count = menu.options.length;
      return live<MenuPick>(
        input,
        output,
        () => menuFrame(menu, selected),
        (key, settle, redraw) => {
          if (key.kind === 'interrupt') {
            settle.reject(new GateInterrupted());
            return;
          }
          if (key.kind === 'up' || key.kind === 'down') {
            selected = (selected + (key.kind === 'up' ? count - 1 : 1)) % count;
            redraw();
            return;
          }
          if (key.kind === 'enter' || (key.kind === 'text' && key.value === ' ')) {
            settle.resolve({ index: selected });
            return;
          }
          if (key.kind === 'text' && key.value === 'd') {
            settle.resolve({ index: selected, dismiss: true });
            return;
          }
          if (key.kind === 'text' && /^[1-9]$/.test(key.value)) {
            const numbered = menu.options.some((option) => option.kind === 'item')
              ? menu.options.filter((option) => option.kind === 'item')
              : menu.options;
            const picked = numbered[Number(key.value) - 1];
            const index = picked ? menu.options.indexOf(picked) : -1;
            if (index >= 0) {
              settle.resolve({ index });
            }
          }
        },
      );
    },
    line: (label) => {
      let value = '';
      return live<string>(
        input,
        output,
        () => [{ text: `${label} ${value}▏` }],
        (key, settle, redraw) => {
          if (key.kind === 'interrupt') {
            settle.reject(new GateInterrupted());
          } else if (key.kind === 'enter') {
            settle.resolve(value);
          } else if (key.kind === 'backspace') {
            value = [...value].slice(0, -1).join('');
            redraw();
          } else if (key.kind === 'text') {
            value += key.value;
            redraw();
          }
        },
      );
    },
  };
}
