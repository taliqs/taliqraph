import { EFFORT_LEVELS } from '../../shared/types/effort';
import { z } from 'zod';
import { WORKFLOW_INPUT_TYPES } from './workflow-definition';

export const workflowFileSchema = z.object({
  name: z.string().min(1),
  title: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  extends: z.string().min(1).optional(),
  // `match:` and `kind:` are accepted and ignored: zod drops unknown keys
  /** What a host asks for: name → type spec or a plain example value. */
  inputs: z.record(z.string(), z.unknown()).default({}),
  /** Names, `NAME?` = optional. Values never appear in a definition. */
  secrets: z.array(z.string().min(1)).default([]),
  /** Host variables passed through into the clean step environment. */
  env: z.array(z.string().min(1)).default([]),
  steps: z.array(z.record(z.string(), z.unknown())).min(1),
});

export const inputSpecSchema = z.object({
  type: z.enum(WORKFLOW_INPUT_TYPES),
  required: z.boolean().optional(),
  description: z.string().optional(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  options: z.array(z.string().min(1)).min(1).optional(),
});

const effortSchema = z.enum(EFFORT_LEVELS);

export const onBlockingSchema = z.object({
  goto: z.string().min(1),
  max_loops: z.number().int().positive().default(3),
  then: z.enum(['gate', 'fail']).default('gate'),
});

const whenSchema = z.object({
  max_runs: z.number().int().positive(),
});

export const agentStepSchema = z.object({
  id: z.string().min(1),
  agent: z.string().min(1),
  model: z.string().min(1).optional(),
  effort: effortSchema.optional(),
  input: z.array(z.string()).default([]),
  output: z.string().min(1).optional(),
  on_blocking: onBlockingSchema.optional(),
  secrets: z.array(z.string().min(1)).optional(),
  when: whenSchema.optional(),
});

export const scriptStepSchema = z.object({
  id: z.string().min(1),
  script: z.string().min(1),
  input: z.array(z.string().min(1)).optional(),
  /** Named parameters: `$<ref>` strings resolve at run time, anything else is a literal. */
  with: z.record(z.string(), z.unknown()).optional(),
  output: z.string().min(1).optional(),
  secrets: z.array(z.string().min(1)).optional(),
  when: whenSchema.optional(),
});

export const gateStepSchema = z.object({
  id: z.string().min(1),
  gate: z.enum(['approve', 'choice', 'select']),
  show: z
    .union([z.string(), z.array(z.string())])
    .default([])
    .transform((value) => (typeof value === 'string' ? [value] : value)),
  editable: z.boolean().default(false),
  list: z.string().min(1).optional(),
  choices: z
    .array(
      z.object({
        id: z.string().regex(/^[a-z][a-z0-9-]*$/, 'lowercase letters, digits and dashes'),
        label: z.string().min(1),
        needs: z.enum(['selection', 'none']).optional(),
        default: z.boolean().optional(),
      }),
    )
    .min(1)
    .optional(),
});

export const subWorkflowStepSchema = z.object({
  id: z.string().min(1),
  workflow: z.string().min(1),
  on_blocking: onBlockingSchema.optional(),
  when: whenSchema.optional(),
});

const comparatorFields = {
  equals: z.unknown().optional(),
  not_equals: z.unknown().optional(),
  gte: z.number().optional(),
  lte: z.number().optional(),
  in: z.array(z.unknown()).optional(),
};

const branchSchema = z.union([z.string().min(1), z.array(z.record(z.string(), z.unknown()))]);

export const conditionStepSchema = z.object({
  id: z.string().min(1),
  if: z.string().min(1),
  // Both optional: an absent `then`/`else` means "just continue" on that side,
  // e.g. an else-only condition that only does extra work on false.
  then: branchSchema.optional(),
  else: branchSchema.optional(),
  ...comparatorFields,
});

export const whileStepSchema = z.object({
  id: z.string().min(1),
  while: z.string().min(1),
  goto: z.string().min(1),
  max_loops: z.number().int().positive().default(3),
  ...comparatorFields,
});

const forkFailureSchema = z.enum(['fail', 'continue', 'ask']).optional();

export const forEachStepSchema = z.object({
  id: z.string().min(1),
  for_each: z.string().min(1),
  as: z.string().min(1).optional(),
  max_items: z.number().int().min(1).max(50).optional(),
  on_fail: forkFailureSchema,
  on_blocking: onBlockingSchema.optional(),
  do: z.record(z.string(), z.unknown()),
});

export const parallelStepSchema = z.object({
  id: z.string().min(1),
  // A branch is either a bare step record (the single-step shorthand) or
  // a YAML sequence of step records (a multi-step chain).
  parallel: z
    .array(
      z.union([
        z.record(z.string(), z.unknown()),
        z.array(z.record(z.string(), z.unknown())).min(1),
      ]),
    )
    .min(2),
  on_fail: forkFailureSchema,
  on_blocking: onBlockingSchema.optional(),
});

export const gotoStepSchema = z.object({
  id: z.string().min(1),
  goto: z.string().min(1),
  max_loops: z.number().int().positive().default(3),
});

export const finishStepSchema = z.object({
  id: z.string().min(1),
  finish: z.literal('run'),
  /** What the run returns: positional references … */
  input: z.array(z.string().min(1)).optional(),
  /** … and named fields (`$ref` resolves, anything else is a literal). */
  with: z.record(z.string(), z.unknown()).optional(),
});

export const failStepSchema = z.object({
  id: z.string().min(1),
  fail: z.string().min(1),
  input: z.array(z.string().min(1)).optional(),
  with: z.record(z.string(), z.unknown()).optional(),
});

export const STEP_DISCRIMINATORS = [
  'agent',
  'gate',
  'workflow',
  'script',
  'if',
  'while',
  'parallel',
  'for_each',
  'goto',
  'finish',
  'fail',
] as const;
