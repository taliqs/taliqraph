import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { McpServerSpec } from '../../engines/engine-adapter';

const specSchema = z.discriminatedUnion('kind', [
  z.object({
    name: z.string().min(1),
    kind: z.literal('stdio'),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
  }),
  z.object({
    name: z.string().min(1),
    kind: z.literal('http'),
    url: z.string().url(),
    headers: z.record(z.string(), z.string()).optional(),
  }),
]);

/**
 * `--mcp-servers <file>`: a JSON array of servers to offer the agents, each
 * `{ name, kind: "stdio", command, args?, env? }` or
 * `{ name, kind: "http", url, headers? }`. Header values are the values
 * themselves; keep the file out of version control when they are secrets.
 */
export async function readMcpServersFile(path: string, cwd: string): Promise<McpServerSpec[]> {
  const file = resolve(cwd, path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'));
  } catch (cause) {
    throw new Error(`${path}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  const result = z.array(specSchema).safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `${path}: expected a JSON array of MCP servers ({ name, kind: stdio | http, ... }) - ${result.error.issues.map((issue) => issue.message).join('; ')}`,
    );
  }
  return result.data as McpServerSpec[];
}
