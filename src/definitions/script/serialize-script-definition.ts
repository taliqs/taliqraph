import { stringify as stringifyYaml } from 'yaml';
import type { ScriptDefinition } from './script-definition';
import { DEFAULT_SCRIPT_TIMEOUT_MINUTES } from './script-definition';

/**
 * Renders a ScriptDefinition back into its `script.yaml`, the inverse of
 * parseScriptDefinition. Scope and folder are implied by location and never
 * serialized; the report skeleton goes back to a YAML mapping.
 */
export function serializeScriptDefinition(script: ScriptDefinition): string {
  const inputs = script.inputs.map((input) =>
    input.required && !input.description
      ? input.name
      : {
          name: input.name,
          required: input.required,
          ...(input.description ? { description: input.description } : {}),
        },
  );
  const manifest: Record<string, unknown> = {
    name: script.name,
    ...(script.title ? { title: script.title } : {}),
    description: script.description,
    run: script.run,
    ...(inputs.length > 0 ? { inputs } : {}),
    ...(script.reportExample ? { report: JSON.parse(script.reportExample) as unknown } : {}),
    ...(script.timeoutMinutes !== DEFAULT_SCRIPT_TIMEOUT_MINUTES
      ? { timeout_minutes: script.timeoutMinutes }
      : {}),
  };
  return stringifyYaml(manifest, { lineWidth: 0 });
}
