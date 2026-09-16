import type {
  WorkflowDefinition,
  WorkflowSecret,
} from '../definitions/workflow/workflow-definition';

export interface ResolvedSecrets {
  /** Name → plaintext for every declared secret that was found. */
  readonly values: Readonly<Record<string, string>>;
  /** Required names found nowhere - the run must not start. */
  readonly missing: readonly string[];
}

/**
 * Resolves declared secrets against the values the host provides (its
 * environment, whatever it keeps). Optional names that are absent are simply
 * not in `values`.
 */
export function resolveSecrets(
  declared: readonly WorkflowSecret[],
  available: Readonly<Record<string, string | undefined>>,
): ResolvedSecrets {
  const values: Record<string, string> = {};
  const missing: string[] = [];
  for (const secret of declared) {
    const found = available[secret.name];
    if (found !== undefined && found.length > 0) {
      values[secret.name] = found;
    } else if (secret.required) {
      missing.push(secret.name);
    }
  }
  return { values, missing };
}

/**
 * Everything a run may need: the workflow's own declarations plus those of
 * every sub-workflow it reaches, deduplicated (required wins over optional).
 * A child's declarations are its own contract - the parent must be able to
 * satisfy them, so they count as if the parent declared them.
 */
export function declaredSecretsOf(
  workflow: WorkflowDefinition,
  resolveWorkflow: (name: string) => WorkflowDefinition | undefined,
): WorkflowSecret[] {
  const byName = new Map<string, WorkflowSecret>();
  const seen = new Set<string>();
  const visit = (current: WorkflowDefinition): void => {
    if (seen.has(current.name)) {
      return;
    }
    seen.add(current.name);
    for (const secret of current.secrets ?? []) {
      const existing = byName.get(secret.name);
      if (!existing || (secret.required && !existing.required)) {
        byName.set(secret.name, secret);
      }
    }
    for (const step of current.steps) {
      if (step.kind === 'workflow') {
        const child = resolveWorkflow(step.workflow);
        if (child) {
          visit(child);
        }
      }
    }
  };
  visit(workflow);
  return [...byName.values()];
}
