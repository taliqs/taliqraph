import type { GateSelection } from '../../orchestrator/run-event';
import type { GateDecision, GateRequest } from '../../runner/types';
import type { MenuModel } from './menu-options';
import { buildMenu, menuAction } from './menu-options';

/** What the menu came back with: the highlighted entry, picked or (with `d`) dismissed. */
export interface MenuPick {
  readonly index: number;
  readonly dismiss?: boolean;
}

/** The two things a terminal asks: pick from a menu, type a line. Both reject with GateInterrupted on Ctrl+C. */
export interface GatePrompt {
  menu(menu: MenuModel): Promise<MenuPick>;
  line(label: string): Promise<string>;
}

export class GateInterrupted extends Error {
  constructor() {
    super('interrupted at a gate');
    this.name = 'GateInterrupted';
  }
}

/**
 * The run's gate handler for a terminal: the menu is shown until an entry
 * resolves the gate, ticks and dismissals on a checklist re-show it. A note
 * or an answer is typed on a line. Ctrl+C stops the run through `interrupt`.
 */
export function terminalGate(
  prompt: GatePrompt,
  interrupt: () => void,
): (gate: GateRequest) => Promise<GateDecision> {
  return async (gate) => {
    let selection = gate.selection;
    let highlighted = 0;
    try {
      for (;;) {
        const menu: MenuModel = { ...buildMenu(gate, selection), selected: highlighted };
        const pick = await prompt.menu(menu);
        highlighted = pick.index;
        const action = menuAction(gate, pick.index, pick.dismiss ?? false);
        if (!action) {
          continue;
        }
        if (action.kind === 'toggle' || action.kind === 'dismiss') {
          selection = patched(gate, selection, action);
          continue;
        }
        if (action.kind === 'note') {
          const text = await prompt.line(action.label);
          return decisionOf(gate, selection, action.approved, text || undefined);
        }
        const choice = gate.choices?.find((candidate) => candidate.id === action.choice);
        const ticked = selection?.selected.length ?? gate.items?.length ?? 0;
        if (choice?.needs === 'selection' && (gate.items?.length ?? 0) > 0 && ticked === 0) {
          // the exit needs ticks and everything is unticked; the desktop greys the button out
          continue;
        }
        return decisionOf(gate, selection, action.approved, action.note, action.choice);
      }
    } catch (cause) {
      if (cause instanceof GateInterrupted) {
        interrupt();
        return { approved: false };
      }
      throw cause;
    }
  };
}

/** A question is answered, everything else approved or sent back; a checklist carries its ticks along. */
function decisionOf(
  gate: GateRequest,
  selection: GateSelection | undefined,
  approved: boolean,
  text: string | undefined,
  choice?: string,
): GateDecision {
  if (gate.kind === 'question') {
    return { approved: true, ...(text !== undefined ? { answer: text } : {}) };
  }
  return {
    approved,
    ...(text !== undefined ? { note: text } : {}),
    ...(choice ? { choice } : {}),
    ...(gate.items && selection
      ? { selected: selection.selected, dismissed: selection.dismissed }
      : {}),
  };
}

/** The selection after a tick flipped or an item dismissed; with none yet, every item counts as ticked. */
function patched(
  gate: GateRequest,
  selection: GateSelection | undefined,
  action: { readonly kind: 'toggle' | 'dismiss'; readonly key: string },
): GateSelection {
  const items = gate.items ?? [];
  const selected = new Set(selection?.selected ?? items.map((item) => item.key));
  const dismissed = selection?.dismissed ?? [];
  if (action.kind === 'dismiss') {
    return {
      selected: [...selected].filter((key) => key !== action.key),
      dismissed: [
        ...dismissed.filter((entry) => entry.key !== action.key),
        { key: action.key, reason: 'dismissed in the terminal' },
      ],
    };
  }
  return {
    selected: items
      .map((item) => item.key)
      .filter((key) => (key === action.key ? !selected.has(key) : selected.has(key))),
    dismissed: dismissed.filter((entry) => entry.key !== action.key),
  };
}
