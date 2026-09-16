import type { EffortLevel } from '../../shared/types/effort';
import type { DefinitionScope } from '../scope';

export interface ToolPolicy {
  readonly read: 'always' | 'off';
  readonly write: 'workspace' | 'anywhere' | 'off';
  readonly commands: 'allowlist' | 'sandbox' | 'off';
  readonly commandAllowlist: readonly string[];
  readonly network: 'off' | 'allowlist';
  /** Configured MCP servers this agent may use (names). Default off: empty. */
  readonly mcp: readonly string[];
}

export interface AgentDefinition {
  readonly name: string;
  readonly description: string;
  /** Skills attached to this agent; the only way a skill reaches a run. */
  readonly skills?: readonly string[];
  readonly engine: string;
  readonly model: string;
  readonly effort: EffortLevel;
  readonly tools: ToolPolicy;
  readonly scope: DefinitionScope;
  /** Behavioral instructions only; the report contract lives in reportExample. */
  readonly prompt: string;
  /**
   * JSON skeleton of the report this agent must end with (the `## Report`
   * section of the file). The orchestrator appends the "end your reply with
   * exactly this fenced JSON" instruction itself, parses the reply's trailing
   * JSON into the step's output, and downstream steps consume those fields,
   * which is why it is a separate field, not editable prose.
   */
  readonly reportExample?: string;
}
