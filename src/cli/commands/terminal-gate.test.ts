import type { GateRequest } from '../../runner/types';
import { describe, expect, it } from 'vitest';
import type { MenuModel } from './menu-options';
import type { GatePrompt, MenuPick } from './terminal-gate';
import { GateInterrupted, terminalGate } from './terminal-gate';

/** A prompt that answers from a script: menu picks in order, then typed lines in order. */
function scripted(
  picks: readonly MenuPick[],
  lines: readonly string[] = [],
): GatePrompt & { readonly menus: MenuModel[]; readonly labels: string[] } {
  const menus: MenuModel[] = [];
  const labels: string[] = [];
  const queue = [...picks];
  const typed = [...lines];
  return {
    menus,
    labels,
    menu: (menu) => {
      menus.push(menu);
      const next = queue.shift();
      return next ? Promise.resolve(next) : Promise.reject(new Error('no pick scripted'));
    },
    line: (label) => {
      labels.push(label);
      const next = typed.shift();
      return next !== undefined ? Promise.resolve(next) : Promise.reject(new Error('no line'));
    },
  };
}

const approve: GateRequest = {
  stepId: 'approve',
  kind: 'approve',
  show: ['plan'],
  shown: { plan: 'do it' },
};

describe('terminalGate', () => {
  it('approves from the first entry', async () => {
    const prompt = scripted([{ index: 0 }]);
    const decision = await terminalGate(prompt, () => undefined)(approve);
    expect(decision).toEqual({ approved: true });
    expect(prompt.menus[0]?.options.map((option) => option.label)).toEqual([
      'Approve',
      'Reject',
      'Send it back with a note…',
    ]);
  });

  it('rejects with the typed note', async () => {
    const prompt = scripted([{ index: 2 }], ['too broad']);
    const decision = await terminalGate(prompt, () => undefined)(approve);
    expect(decision).toEqual({ approved: false, note: 'too broad' });
    expect(prompt.labels).toEqual(['note ›']);
  });

  it('picks an exit on a gate with choices and keeps the highlight where it was', async () => {
    const gate: GateRequest = {
      stepId: 'route',
      kind: 'choice',
      show: [],
      choices: [
        { id: 'ship', label: 'Ship it', needs: 'none' },
        { id: 'rework', label: 'Rework', needs: 'none' },
      ],
    };
    // an entry off the menu is ignored and the menu comes back, highlight intact
    const prompt = scripted([{ index: 5 }, { index: 1 }]);
    const decision = await terminalGate(prompt, () => undefined)(gate);
    expect(decision).toEqual({ approved: true, choice: 'rework' });
    expect(prompt.menus).toHaveLength(2);
    expect(prompt.menus[1]?.selected).toBe(5);
  });

  it('ticks, dismisses and then sends the selection with the chosen exit', async () => {
    const gate: GateRequest = {
      stepId: 'triage',
      kind: 'choice',
      show: ['review'],
      items: [
        { key: 'f1', ref: 'review', value: { label: 'first' } },
        { key: 'f2', ref: 'review', value: { label: 'second' } },
        { key: 'f3', ref: 'review', value: { label: 'third' } },
      ],
      choices: [
        { id: 'post', label: 'Post', needs: 'selection' },
        { id: 'skip', label: 'Skip', needs: 'none' },
      ],
      selection: { selected: ['f1', 'f2', 'f3'], dismissed: [] },
    };
    const prompt = scripted([{ index: 0 }, { index: 1, dismiss: true }, { index: 3 }]);
    const decision = await terminalGate(prompt, () => undefined)(gate);
    expect(decision).toEqual({
      approved: true,
      choice: 'post',
      selected: ['f3'],
      dismissed: [{ key: 'f2', reason: 'dismissed in the terminal' }],
    });
    expect(prompt.menus[2]?.options.slice(0, 3).map((option) => option.label)).toEqual([
      '[ ] first',
      '[✕] second (dismissed: dismissed in the terminal)',
      '[✓] third',
    ]);
  });

  it('re-asks when an exit that needs ticks is picked with nothing ticked', async () => {
    const gate: GateRequest = {
      stepId: 'triage',
      kind: 'choice',
      show: [],
      items: [{ key: 'f1', ref: 'review', value: 'only' }],
      choices: [
        { id: 'post', label: 'Post', needs: 'selection' },
        { id: 'skip', label: 'Skip', needs: 'none' },
      ],
      selection: { selected: ['f1'], dismissed: [] },
    };
    const prompt = scripted([{ index: 0 }, { index: 1 }, { index: 2 }]);
    const decision = await terminalGate(prompt, () => undefined)(gate);
    expect(decision).toEqual({ approved: true, choice: 'skip', selected: [], dismissed: [] });
    expect(prompt.menus).toHaveLength(3);
  });

  it('answers a question with a suggestion or a typed answer', async () => {
    const gate: GateRequest = {
      stepId: 'implement',
      kind: 'question',
      show: [],
      question: 'Which db?',
      suggestions: ['sqlite', 'postgres'],
    };
    await expect(terminalGate(scripted([{ index: 1 }]), () => undefined)(gate)).resolves.toEqual({
      approved: true,
      answer: 'postgres',
    });
    const prompt = scripted([{ index: 2 }], ['mysql']);
    await expect(terminalGate(prompt, () => undefined)(gate)).resolves.toEqual({
      approved: true,
      answer: 'mysql',
    });
    expect(prompt.labels).toEqual(['answer ›']);
  });

  it('allows or denies a permission ask, with a reason when asked for one', async () => {
    const gate: GateRequest = {
      stepId: 'implement',
      kind: 'permission',
      show: [],
      question: 'Run npm install?',
    };
    await expect(terminalGate(scripted([{ index: 0 }]), () => undefined)(gate)).resolves.toEqual({
      approved: true,
    });
    await expect(terminalGate(scripted([{ index: 1 }]), () => undefined)(gate)).resolves.toEqual({
      approved: false,
    });
    await expect(
      terminalGate(scripted([{ index: 2 }], ['not on CI']), () => undefined)(gate),
    ).resolves.toEqual({ approved: false, note: 'not on CI' });
  });

  it('stops the run on Ctrl+C and sends the gate back', async () => {
    let interrupted = 0;
    const prompt: GatePrompt = {
      menu: () => Promise.reject(new GateInterrupted()),
      line: () => Promise.reject(new GateInterrupted()),
    };
    const decision = await terminalGate(prompt, () => {
      interrupted += 1;
    })(approve);
    expect(decision).toEqual({ approved: false });
    expect(interrupted).toBe(1);
  });

  it('answers a choice that needs ticks when the gate has nothing to tick', async () => {
    // every choice defaults to needs: selection; without a select list there is nothing to tick,
    // so the pick must go through instead of re-asking forever
    const gate: GateRequest = {
      stepId: 'check',
      kind: 'choice',
      show: [],
      choices: [
        { id: 'ship', label: 'Ship it', needs: 'selection' },
        { id: 'hold', label: 'Hold', needs: 'selection' },
      ],
    };
    const prompt = scripted([{ index: 0 }]);
    const decision = await terminalGate(prompt, () => undefined)(gate);
    expect(decision).toEqual({ approved: true, choice: 'ship' });
    expect(prompt.menus).toHaveLength(1);
  });
});
