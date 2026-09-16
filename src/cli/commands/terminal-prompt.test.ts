import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { MenuModel } from './menu-options';
import { GateInterrupted } from './terminal-gate';
import { terminalPrompt } from './terminal-prompt';

const ESCAPE = String.fromCharCode(0x1b);

/** A terminal on strings: what was written, and keys pushed in as the user types them. */
function fakeTerminal(): {
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
  written: string[];
  type(text: string): void;
  rawModes: boolean[];
} {
  const written: string[] = [];
  const rawModes: boolean[] = [];
  const emitter = new EventEmitter();
  const input = Object.assign(emitter, {
    isTTY: true,
    isRaw: false,
    setRawMode: (raw: boolean) => {
      rawModes.push(raw);
      return input;
    },
    setEncoding: () => input,
    resume: () => input,
    pause: () => input,
  }) as unknown as NodeJS.ReadStream;
  const output = {
    isTTY: true,
    columns: 80,
    write: (text: string) => written.push(text),
  } as unknown as NodeJS.WriteStream;
  return { input, output, written, rawModes, type: (text) => emitter.emit('data', text) };
}

const MENU: MenuModel = {
  title: 'gate',
  body: ['what it shows'],
  options: [
    { label: 'Approve', kind: 'exit' },
    { label: 'Reject', kind: 'exit' },
    { label: 'Send it back with a note', kind: 'exit' },
  ],
  selected: 0,
};

const TICKS: MenuModel = {
  title: 'triage',
  body: [],
  options: [
    { label: '[✓] first', kind: 'item' },
    { label: '[ ] second', kind: 'item' },
    { label: 'Continue', kind: 'exit' },
    { label: 'Stop here', kind: 'exit' },
  ],
  selected: 0,
};

describe('terminalPrompt', () => {
  it('draws the menu, moves with the arrows and answers with Enter', async () => {
    const terminal = fakeTerminal();
    const picked = terminalPrompt(terminal.input, terminal.output).menu(MENU);
    const first = terminal.written.join('');
    expect(first).toContain('gate');
    expect(first).toContain('what it shows');
    expect(first).toContain('1. Approve');
    expect(first).toContain('Ctrl+C stop the run');
    terminal.type(`${ESCAPE}[B`);
    terminal.type('\r');
    expect(await picked).toEqual({ index: 1 });
    // raw mode is turned on for the prompt and handed back afterwards
    expect(terminal.rawModes).toEqual([true, false]);
    // the frame is erased, so the feed keeps the record
    expect(terminal.written.at(-1)).toContain(`${ESCAPE}[0J`);
  });

  it('jumps with a digit and dismisses with d', async () => {
    const byDigit = fakeTerminal();
    const jumped = terminalPrompt(byDigit.input, byDigit.output).menu(MENU);
    byDigit.type('3');
    expect(await jumped).toEqual({ index: 2 });

    const byKey = fakeTerminal();
    const dismissed = terminalPrompt(byKey.input, byKey.output).menu(MENU);
    byKey.type('d');
    expect(await dismissed).toEqual({ index: 0, dismiss: true });
  });

  it('types a line, backspaces over it, and submits on Enter', async () => {
    const terminal = fakeTerminal();
    const typed = terminalPrompt(terminal.input, terminal.output).line('note ›');
    terminal.type('too risky');
    terminal.type('');
    expect(terminal.written.join('')).toContain('note › too risk');
    terminal.type('\r');
    expect(await typed).toBe('too risk');
  });

  it('Ctrl+C rejects so the run can stop', async () => {
    const terminal = fakeTerminal();
    const picked = terminalPrompt(terminal.input, terminal.output).menu(MENU);
    terminal.type('');
    await expect(picked).rejects.toBeInstanceOf(GateInterrupted);
  });

  it('numbers the entries to tick, leaves the exits unnumbered, and keeps them apart', async () => {
    const terminal = fakeTerminal();
    const picked = terminalPrompt(terminal.input, terminal.output).menu(TICKS);
    const frame = terminal.written.join('');
    expect(frame).toContain('1. [✓] first');
    expect(frame).toContain('2. [ ] second');
    expect(frame).toContain('   Continue');
    expect(frame).not.toContain('3. Continue');
    expect(frame).toContain('1-2 jump');
    // a digit jumps within the entries, never into the exits
    terminal.type('2');
    expect(await picked).toEqual({ index: 1 });
  });
});
