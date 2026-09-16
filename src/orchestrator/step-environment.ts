import type { TaskRunContext } from './workflow-run';

/** What one step's process sees: the clean base, then only the secrets the step lists. */
export function stepEnvironment(
  context: Pick<TaskRunContext, 'env' | 'secrets'>,
  secretNames: readonly string[] | undefined,
): Readonly<Record<string, string>> | undefined {
  if (!context.env) {
    return undefined;
  }
  const env: Record<string, string> = { ...context.env };
  for (const name of secretNames ?? []) {
    const value = context.secrets?.[name];
    if (value !== undefined) {
      env[name] = value;
    }
  }
  return env;
}
