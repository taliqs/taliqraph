import type { ReferenceHint } from './reference-scope';
import type { ProblemCode } from './workflow-problem';

export type ReferenceStatus =
  | { readonly level: 'ok' }
  | {
      readonly level: 'info' | 'warning' | 'error';
      readonly code: ProblemCode;
      readonly message: string;
      readonly hint?: string;
    };

/**
 * How one reference fares against a scope: ok, or a problem with a stable
 * code and a self-contained message (it names the reference). `extras` are
 * the names a field accepts beyond step outputs (`task`, `all` for inputs;
 * `diff` for a gate's show; a for-each's item name).
 */
export function checkReference(
  ref: string,
  hints: readonly ReferenceHint[],
  extras: readonly string[] = [],
): ReferenceStatus {
  if (extras.includes(ref)) {
    return { level: 'ok' };
  }
  const unreachable = (): ReferenceStatus => ({
    level: 'error',
    code: 'ref/unreachable-later',
    message: `‘${ref}’ runs after this step and nothing loops back before it - it can never be available here`,
  });
  const later = (): ReferenceStatus => ({
    level: 'warning',
    code: 'ref/later-pass',
    message: `‘${ref}’ is produced by a step that runs after this one - there from a loop’s second pass on, "(not available)" before`,
  });
  const fromHint = (hint: ReferenceHint): ReferenceStatus => {
    if (hint.unreachable) {
      return unreachable();
    }
    if (hint.later) {
      return later();
    }
    if (hint.conditional) {
      return {
        level: 'info',
        code: 'ref/conditional',
        message: `‘${ref}’ is written ${hint.conditional} - "(not available)" when the other side ran`,
      };
    }
    return { level: 'ok' };
  };
  const exact = hints.find((hint) => hint.path === ref);
  if (exact) {
    return fromHint(exact);
  }
  if (ref.endsWith('.length')) {
    const parent = hints.find((hint) => hint.path === ref.slice(0, -'.length'.length));
    if (parent && (parent.type === 'string' || parent.type === 'list')) {
      return fromHint(parent);
    }
  }
  const root = ref.split('.')[0] ?? ref;
  if (root === 'task') {
    return {
      level: 'error',
      code: 'ref/retired-task',
      message: `‘task’ is gone - there is no brief; declare what this workflow takes under inputs: and read inputs.<name>`,
    };
  }
  if (root === 'inputs') {
    return {
      level: 'error',
      code: 'ref/unknown-input',
      message: `‘${ref}’ names no declared input - declare it under inputs:`,
    };
  }
  if (root === 'run') {
    return {
      level: 'warning',
      code: 'ref/unknown-run-field',
      message: `‘${ref}’ is not a run-state field the linter knows (run.gates.<id>.approved, run.loops.<id>, run.rejections.<id>)`,
    };
  }
  const underRoot = hints.filter((hint) => hint.path === root || hint.path.startsWith(`${root}.`));
  const first = underRoot[0];
  if (first) {
    if (underRoot.every((hint) => hint.unreachable)) {
      return unreachable();
    }
    if (underRoot.every((hint) => hint.later)) {
      return later();
    }
    const declaresFields = underRoot.some((hint) => hint.path !== root);
    if (!declaresFields) {
      return fromHint(first); // the producer declares no shape - nothing to check against
    }
    return {
      level: 'warning',
      code: 'ref/not-in-skeleton',
      message: `‘${ref}’ is not in ${root}’s report skeleton - arrives as "(not available)" unless the step adds that field`,
    };
  }
  const roots = [
    ...new Set(
      hints.filter((hint) => !hint.unreachable).map((hint) => hint.path.split('.')[0] ?? ''),
    ),
  ];
  const guess = closest(root, [...roots.filter((entry) => entry.length > 0), ...extras]);
  return {
    level: 'error',
    code: 'ref/unknown-producer',
    message: `nothing produces ‘${root}’`,
    ...(guess ? { hint: `did you mean ${guess}?` } : {}),
  };
}

function closest(word: string, candidates: readonly string[]): string | undefined {
  const target = word.toLowerCase();
  let best: { candidate: string; distance: number } | undefined;
  for (const candidate of candidates) {
    const lower = candidate.toLowerCase();
    const distance =
      lower.includes(target) || target.includes(lower) ? 1 : levenshtein(target, lower);
    if (!best || distance < best.distance) {
      best = { candidate, distance };
    }
  }
  return best && best.distance <= Math.max(2, Math.floor(target.length / 3))
    ? best.candidate
    : undefined;
}

function levenshtein(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const table: number[] = Array.from({ length: rows * cols }, () => 0);
  for (let i = 0; i < rows; i += 1) table[i * cols] = i;
  for (let j = 0; j < cols; j += 1) table[j] = j;
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      table[i * cols + j] = Math.min(
        (table[(i - 1) * cols + j] as number) + 1,
        (table[i * cols + j - 1] as number) + 1,
        (table[(i - 1) * cols + j - 1] as number) + cost,
      );
    }
  }
  return table[rows * cols - 1] as number;
}
