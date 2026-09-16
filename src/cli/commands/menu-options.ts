import type { GateSelection } from '../../orchestrator/run-event';
import type { GateRequest } from '../../runner/types';

/**
 * One line of the menu: an entry to tick, or an exit that answers the gate.
 * Entries are numbered so a digit jumps to them; the exits below are not.
 */
export interface MenuEntry {
  readonly label: string;
  readonly kind: 'item' | 'exit';
}

export interface MenuModel {
  readonly title: string;
  /** Lines shown above the options: the plan, the shown references, the agent's question. */
  readonly body: readonly string[];
  readonly options: readonly MenuEntry[];
  readonly selected: number;
}

const item = (label: string): MenuEntry => ({ label, kind: 'item' });
const exit = (label: string): MenuEntry => ({ label, kind: 'exit' });

/** What picking a menu entry does. */
export type MenuAction =
  | {
      readonly kind: 'resolve';
      readonly approved: boolean;
      /** A picked suggestion on a question; feedback on a send-back. */
      readonly note?: string;
      /** The picked exit on a gate with choices. */
      readonly choice?: string;
    }
  /** Opens the note line; the note is sent with this approval value. */
  | { readonly kind: 'note'; readonly label: string; readonly approved: boolean }
  /** Space / Enter on a checklist item flips its tick; `d` dismisses it. */
  | { readonly kind: 'toggle'; readonly key: string }
  | { readonly kind: 'dismiss'; readonly key: string };

const MAX_BODY_LINES = 14;

/** The boxed menu for a gate, an agent's question or a permission ask. */
export function buildMenu(
  gate: GateRequest,
  selection: GateSelection | undefined = gate.selection,
): Omit<MenuModel, 'selected'> {
  if (gate.kind === 'question') {
    return {
      title: `🤖 ${gate.stepId} asks`,
      body: wrap(gate.question ?? ''),
      options: [...(gate.suggestions ?? []).map(exit), exit('Answer with a message…')],
    };
  }
  if (gate.kind === 'permission') {
    return {
      title: `🤖 ${gate.stepId} asks permission`,
      body: wrap(gate.question ?? ''),
      options: [exit('Yes, once'), exit('No'), exit('Say no with a message…')],
    };
  }
  if (gate.items || gate.choices) {
    const items = gate.items ?? [];
    const selected = new Set(selection?.selected ?? items.map((item) => item.key));
    const dismissed = new Map(
      (selection?.dismissed ?? []).map((entry) => [entry.key, entry.reason]),
    );
    const checklist = items.map((entry) => {
      const gone = dismissed.get(entry.key);
      const box = gone !== undefined ? '[✕]' : selected.has(entry.key) ? '[✓]' : '[ ]';
      return item(`${box} ${itemLabel(entry.value)}${gone ? ` (dismissed: ${gone})` : ''}`);
    });
    const exits = (gate.choices ?? []).map((choice) => exit(choice.label));
    return {
      title: `👤 ${gate.stepId}`,
      body: items.length > 0 ? [] : shownLines(gate).slice(0, MAX_BODY_LINES),
      options: [
        ...checklist,
        ...exits,
        ...(gate.choices
          ? []
          : [exit('Approve'), exit('Reject'), exit('Send it back with a note…')]),
      ],
    };
  }
  return {
    title: `👤 ${gate.stepId}`,
    body: shownLines(gate).slice(0, MAX_BODY_LINES),
    options: [exit('Approve'), exit('Reject'), exit('Send it back with a note…')],
  };
}

/** The action behind entry `index`; `dismiss` is the `d` key, which only a checklist item answers to. */
export function menuAction(
  gate: GateRequest,
  index: number,
  dismiss = false,
): MenuAction | undefined {
  if (gate.kind === 'question') {
    const suggestions = gate.suggestions ?? [];
    const picked = suggestions[index];
    if (dismiss) {
      return undefined;
    }
    if (picked !== undefined) {
      return { kind: 'resolve', approved: true, note: picked };
    }
    return index === suggestions.length
      ? { kind: 'note', label: 'answer ›', approved: true }
      : undefined;
  }
  if (gate.kind === 'permission') {
    const options: readonly MenuAction[] = [
      { kind: 'resolve', approved: true },
      { kind: 'resolve', approved: false },
      { kind: 'note', label: 'no, because ›', approved: false },
    ];
    return dismiss ? undefined : options[index];
  }
  const items = gate.items ?? [];
  const item = items[index];
  if (item) {
    return dismiss ? { kind: 'dismiss', key: item.key } : { kind: 'toggle', key: item.key };
  }
  if (dismiss) {
    return undefined;
  }
  const rest = index - items.length;
  const picked = gate.choices?.[rest];
  if (picked) {
    return { kind: 'resolve', approved: true, choice: picked.id };
  }
  if (gate.choices) {
    return undefined;
  }
  const plain: readonly MenuAction[] = [
    { kind: 'resolve', approved: true },
    { kind: 'resolve', approved: false },
    { kind: 'note', label: 'note ›', approved: false },
  ];
  return plain[rest];
}

/** One checklist line per item: a finding's severity + short text, else its label / first string field. */
function itemLabel(value: unknown): string {
  if (value === null || value === undefined) {
    return '(empty)';
  }
  if (typeof value !== 'object') {
    return String(value);
  }
  const record = value as Record<string, unknown>;
  if (typeof record['short'] === 'string' && typeof record['severity'] === 'string') {
    const refs = Array.isArray(record['refs']) ? record['refs'] : [];
    const ref = refs[0] as { file?: string; line?: number } | undefined;
    const where = ref?.file ? `  ${ref.file}${ref.line ? `:${ref.line}` : ''}` : '';
    const firstLine = String(record['short']).split('\n')[0] ?? '';
    return `[${String(record['severity'])}] ${firstLine}${where}`;
  }
  for (const key of ['label', 'title', 'name', 'summary', 'id']) {
    if (typeof record[key] === 'string') {
      return record[key] as string;
    }
  }
  const first = Object.values(record).find((entry) => typeof entry === 'string');
  return typeof first === 'string' ? first : JSON.stringify(value);
}

/** The `show` references as they were when the gate opened; the diff is not among them in a terminal run. */
function shownLines(gate: GateRequest): string[] {
  const shown = gate.shown ?? {};
  return gate.show
    .filter((name) => name !== 'diff')
    .flatMap((name) => {
      const value = shown[name];
      if (value === undefined) {
        return [`${name}: (not available)`];
      }
      const text = typeof value === 'string' ? value : JSON.stringify(value, null, 1);
      const lines = text.split('\n').filter((line) => line.trim().length > 0);
      return [
        `${name}:`,
        ...lines.slice(0, 8).map((line) => `  ${line}`),
        ...(lines.length > 8 ? ['  …'] : []),
      ];
    });
}

function wrap(text: string, width = 74): string[] {
  return text
    .split('\n')
    .flatMap((paragraph) => paragraph.match(new RegExp(`.{1,${width}}(\\s|$)`, 'g')) ?? [paragraph])
    .map((line) => line.trimEnd());
}
