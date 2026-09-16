import type { DefinitionScope } from '../scope';

/**
 * A scoped rule document (naming, commits, testing, error handling) injected
 * into matching agents' context on every run. Project standards shadow global
 * ones by name.
 */
export interface StandardDefinition {
  readonly name: string;
  readonly description?: string;
  /** Agent names this standard is injected into; empty = every agent. */
  readonly appliesTo: readonly string[];
  readonly scope: DefinitionScope;
  /** The rule text itself, injected verbatim. */
  readonly body: string;
}
