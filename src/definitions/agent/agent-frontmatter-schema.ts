import { EFFORT_LEVELS } from '../../shared/types/effort';
import { z } from 'zod';

const toolsSchema = z
  .object({
    read: z.enum(['always', 'off']).default('always'),
    write: z.enum(['workspace', 'anywhere', 'off']).default('workspace'),
    commands: z.enum(['allowlist', 'sandbox', 'off']).default('allowlist'),
    allowlist: z.array(z.string()).default([]),
    network: z.enum(['off', 'allowlist']).default('off'),
    /** MCP servers this agent may use, by configured server name. Default: none. */
    mcp: z.array(z.string()).default([]),
  })
  .prefault({});

export const agentFrontmatterSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  engine: z.string().min(1),
  model: z.string().min(1),
  effort: z.enum(EFFORT_LEVELS).default('med'),
  tools: toolsSchema,
  skills: z.array(z.string()).default([]),
  output_schema: z.string().min(1).optional(),
  match: z.array(z.string()).default([]),
});

export type AgentFrontmatter = z.infer<typeof agentFrontmatterSchema>;
