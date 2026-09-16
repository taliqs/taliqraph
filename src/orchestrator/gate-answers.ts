import type { GateChoice, GateStep } from '../definitions/workflow/workflow-step';
import type { GateItem, GateSelection } from './run-event';
import { recordOutput } from './output-keys';

/**
 * A gate's checkable items: `select` names a reference that resolves to an
 * array, or a field name looked up in every shown output - all matches
 * concatenate, in `show` order. Keys are the item's own `id` when it has one,
 * else `<ref>:<index>`; duplicates get a suffix so a selection always names
 * exactly one item.
 */
export function gateItemsOf(list: string, valueAt: (ref: string) => unknown): GateItem[] {
  const value = valueAt(list);
  const sources: Array<{ ref: string; list: readonly unknown[] }> = Array.isArray(value)
    ? [{ ref: list, list: value }]
    : [];
  const taken = new Set<string>();
  const items: GateItem[] = [];
  for (const { ref, list } of sources) {
    list.forEach((value, index) => {
      const own =
        value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string'
          ? (value as { id: string }).id
          : `${ref}:${index}`;
      let key = own;
      for (let n = 2; taken.has(key); n += 1) {
        key = `${own}#${n}`;
      }
      taken.add(key);
      items.push({ key, ref, value });
    });
  }
  return items;
}

/** Everything ticked to start with - except items that arrive already dismissed (a withdrawn finding). */
export function defaultSelection(items: readonly GateItem[]): GateSelection {
  const dismissed = items
    .filter((item) => (item.value as { status?: unknown } | null)?.status === 'dismissed')
    .map((item) => ({
      key: item.key,
      reason: String((item.value as { dismissReason?: unknown }).dismissReason ?? ''),
    }));
  const gone = new Set(dismissed.map((entry) => entry.key));
  return {
    selected: items.filter((item) => !gone.has(item.key)).map((item) => item.key),
    dismissed,
  };
}

/** A patch from the UI / CLI / chat over the current state - arrays replace, scalars merge. */
export function mergeSelection(
  current: GateSelection | undefined,
  patch: Partial<GateSelection> | undefined,
): GateSelection {
  const base = current ?? { selected: [], dismissed: [] };
  if (!patch) {
    return base;
  }
  const dismissed = patch.dismissed ?? base.dismissed;
  const gone = new Set(dismissed.map((entry) => entry.key));
  return {
    selected: (patch.selected ?? base.selected).filter((key) => !gone.has(key)),
    dismissed,
    ...((patch.edited ?? base.edited) ? { edited: { ...base.edited, ...patch.edited } } : {}),
    ...((patch.includeDetails ?? base.includeDetails) !== undefined
      ? { includeDetails: patch.includeDetails ?? base.includeDetails }
      : {}),
  };
}

/** The choice's rule: `needs: selection` refuses an empty tick list. */
export function checkChoice(
  gate: GateStep,
  choice: string | undefined,
  selection: GateSelection,
): GateChoice {
  const offered = gate.choices ?? [];
  const picked = offered.find((candidate) => candidate.id === choice);
  if (!picked) {
    throw new Error(
      `Gate '${gate.id}' needs a choice - one of ${offered.map((candidate) => candidate.id).join(', ')}`,
    );
  }
  if (picked.needs === 'selection' && gate.gate === 'select' && selection.selected.length === 0) {
    throw new Error(`'${picked.label}' needs at least one item ticked`);
  }
  return picked;
}

/**
 * The gate's own output: `<id>.approved` / `.note` / `.rejections`, plus
 * `.choice`, `.selected` (the ticked items' values, in display order),
 * `.dismissed` ([{ item, reason }]), `.edited`, `.includeDetails` when the gate
 * asked for them. Shared by the live run and replay so both agree byte for byte.
 */
export function gateOutputOf(
  gate: GateStep,
  base: { approved: boolean; note: string; rejections: number },
  answer: { choice?: string; selection?: GateSelection; items?: readonly GateItem[] },
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  if (gate.choices) {
    out.choice = answer.choice ?? '';
  }
  if (gate.gate === 'select') {
    const items = new Map((answer.items ?? []).map((item) => [item.key, item.value] as const));
    const selection = answer.selection ?? { selected: [], dismissed: [] };
    out.selected = selection.selected.filter((key) => items.has(key)).map((key) => items.get(key));
    out.dismissed = selection.dismissed
      .filter((entry) => items.has(entry.key))
      .map((entry) => ({ item: items.get(entry.key), reason: entry.reason }));
    out.includeDetails = selection.includeDetails ?? false;
  }
  if (gate.editable && answer.selection?.edited) {
    out.edited = answer.selection.edited;
  }
  return out;
}

/** Writes the gate's own output (gateOutputOf) under its id - the live run and replay both go through here. */
export function recordGateOutput(
  outputs: Record<string, unknown>,
  gate: GateStep,
  base: { approved: boolean; note: string; rejections: number },
  answer: { choice?: string; selection?: GateSelection; items?: readonly GateItem[] },
): void {
  recordOutput(outputs, gate, gateOutputOf(gate, base, answer));
}
