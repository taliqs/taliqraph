import type { GateRequest } from '../../runner/types';
import { describe, expect, it } from 'vitest';
import { buildMenu, menuAction } from './menu-options';

describe('buildMenu / menuAction', () => {
  it('renders a gate with items as a checklist above its choices; ticks come from the selection', () => {
    const gate: GateRequest = {
      stepId: 'triage',
      kind: 'choice',
      show: ['review'],
      shown: { review: { findings: 2 } },
      items: [
        { key: 'f1', ref: 'review', value: {} },
        { key: 'f2', ref: 'review', value: {} },
      ],
      choices: [
        { id: 'post', label: 'Post review', needs: 'selection' },
        { id: 'none', label: 'Done', needs: 'none' },
      ],
      selection: { selected: ['f1', 'f2'], dismissed: [] },
    };
    const menu = buildMenu(gate);
    // the checklist first (everything ticked by default), then the exits
    expect(menu.options).toEqual([
      { label: '[✓] {}', kind: 'item' },
      { label: '[✓] {}', kind: 'item' },
      { label: 'Post review', kind: 'exit' },
      { label: 'Done', kind: 'exit' },
    ]);
    expect(menuAction(gate, 0)).toEqual({ kind: 'toggle', key: 'f1' });
    expect(menuAction(gate, 0, true)).toEqual({ kind: 'dismiss', key: 'f1' });
    expect(menuAction(gate, 3)).toEqual({ kind: 'resolve', approved: true, choice: 'none' });
    expect(menuAction(gate, 3, true)).toBeUndefined();
    expect(menuAction(gate, 4)).toBeUndefined();

    const ticked = buildMenu(gate, {
      selected: ['f2'],
      dismissed: [{ key: 'f1', reason: 'noise' }],
    });
    expect(ticked.options.slice(0, 2)).toEqual([
      { label: '[✕] {} (dismissed: noise)', kind: 'item' },
      { label: '[✓] {}', kind: 'item' },
    ]);
  });

  it('renders a plain gate with what it shows and the three answers', () => {
    const gate: GateRequest = {
      stepId: 'approve-plan',
      kind: 'approve',
      show: ['diff', 'plan'],
      shown: { plan: 'Remove Math.abs\nAdd a test' },
    };
    const menu = buildMenu(gate);
    expect(menu.title).toBe('👤 approve-plan');
    expect(menu.body).toEqual(['plan:', '  Remove Math.abs', '  Add a test']);
    expect(menu.options.map((option) => option.label)).toEqual([
      'Approve',
      'Reject',
      'Send it back with a note…',
    ]);
    expect(menuAction(gate, 0)).toEqual({ kind: 'resolve', approved: true });
    expect(menuAction(gate, 1)).toEqual({ kind: 'resolve', approved: false });
    expect(menuAction(gate, 2)).toEqual({ kind: 'note', label: 'note ›', approved: false });
    expect(menuAction(gate, 3)).toBeUndefined();
  });

  it("offers an agent's suggestions first and a free-text answer last", () => {
    const gate: GateRequest = {
      stepId: 'implement',
      kind: 'question',
      show: [],
      question: 'Which db?',
      suggestions: ['sqlite', 'postgres'],
    };
    const menu = buildMenu(gate);
    expect(menu.title).toBe('🤖 implement asks');
    expect(menu.options.map((option) => option.label)).toEqual([
      'sqlite',
      'postgres',
      'Answer with a message…',
    ]);
    expect(menuAction(gate, 1)).toEqual({ kind: 'resolve', approved: true, note: 'postgres' });
    expect(menuAction(gate, 2)).toEqual({ kind: 'note', label: 'answer ›', approved: true });
  });

  it('turns a permission ask into yes / no / no with a reason', () => {
    const gate: GateRequest = {
      stepId: 'implement',
      kind: 'permission',
      show: [],
      question: 'Run npm install?',
    };
    expect(buildMenu(gate).options.map((option) => option.label)).toEqual([
      'Yes, once',
      'No',
      'Say no with a message…',
    ]);
    expect(menuAction(gate, 1)).toEqual({ kind: 'resolve', approved: false });
  });
});
