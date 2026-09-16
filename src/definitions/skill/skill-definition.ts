import type { DefinitionScope } from '../scope';

/**
 * A skill: a packaged, on-demand procedure in the ecosystem's SKILL.md format,
 * loaded into an agent's context when the agent lists it under skills:.
 * Skills are how-to depth; standards are always-on constraints.
 */
export interface SkillDefinition {
  readonly name: string;
  readonly description: string;
  readonly scope: DefinitionScope;
  /** The procedure itself, injected verbatim when attached. */
  readonly body: string;
}
