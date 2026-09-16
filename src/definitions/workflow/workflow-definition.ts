import type { DefinitionScope } from '../scope';
import type { WorkflowStep } from './workflow-step';

/**
 * One secret a workflow declares: a name, never a value. Steps that list
 * it get it bound into their process environment; a required one the host
 * does not provide fails the run before step one.
 */
export interface WorkflowSecret {
  /** Environment-variable shaped: `GH_TOKEN`, `JIRA_API_TOKEN`. */
  readonly name: string;
  /** `NAME?` in the file marks an optional one; absent is fine. */
  readonly required: boolean;
}

/** The input types a workflow may declare. */
export const WORKFLOW_INPUT_TYPES = ['text', 'prompt', 'number', 'boolean', 'choice'] as const;
export type WorkflowInputType = (typeof WORKFLOW_INPUT_TYPES)[number];

/**
 * One declared input: what a host asks for and what steps read as
 * `inputs.<name>`.
 */
export interface WorkflowInput {
  readonly name: string;
  readonly type: WorkflowInputType;
  readonly required: boolean;
  readonly description?: string;
  /** The form's starting value (optional inputs only). */
  readonly default?: string | number | boolean;
  /** `choice` only. */
  readonly options?: readonly string[];
}

export interface WorkflowDefinition {
  readonly name: string;
  readonly title: string;
  /** What this workflow does and when to use it; hosts show this. */
  readonly description?: string;
  readonly extendsName?: string;
  /** What a host asks for and steps read as `inputs.<name>`; absent = takes nothing. */
  readonly inputs?: readonly WorkflowInput[];
  /** The secrets this workflow may hand to its steps; absent = none. */
  readonly secrets?: readonly WorkflowSecret[];
  /**
   * Non-secret environment variables passed through from the host into every
   * step's otherwise clean environment: `HTTP_PROXY`, `NODE_OPTIONS`, …
   */
  readonly env?: readonly string[];
  readonly steps: readonly WorkflowStep[];
  readonly scope: DefinitionScope;
}
