import { resolve, sep } from 'node:path';
import type { EngineRunSpec } from '../engine-adapter';

export interface ToolPermissionDecision {
  readonly allow: boolean;
  readonly reason?: string;
  /** A human may overrule this denial (command off the allowlist, network). */
  readonly escalatable?: boolean;
  /** What to show the human: the command line, the URL, … */
  readonly detail?: string;
}

export type ToolPolicySpec = Pick<
  EngineRunSpec,
  'cwd' | 'allowWrite' | 'allowNetwork' | 'commandAllowlist' | 'mcpServers'
>;

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const NETWORK_TOOLS = new Set(['WebFetch', 'WebSearch']);
const SUBAGENT_TOOLS = new Set(['Task', 'Agent']);

export function decideToolPermission(
  toolName: string,
  input: Record<string, unknown>,
  policy: ToolPolicySpec,
): ToolPermissionDecision {
  if (toolName.startsWith('mcp__')) {
    // SDK MCP tools are named mcp__<server>__<tool>; only the agent's
    // allowlisted servers were handed to the session, but gate again here.
    const server = toolName.split('__')[1] ?? '';
    return (policy.mcpServers ?? []).some((entry) => entry.name === server)
      ? { allow: true }
      : deny(`MCP server '${server}' is not enabled for this agent`);
  }
  if (NETWORK_TOOLS.has(toolName)) {
    if (policy.allowNetwork) {
      return { allow: true };
    }
    return {
      ...deny('network access is disabled for this agent'),
      escalatable: true,
      detail: `${toolName}: ${networkTarget(input) ?? toolName}`,
    };
  }
  if (SUBAGENT_TOOLS.has(toolName)) {
    return deny('sub-agents are orchestrated by workflows, not spawned ad hoc');
  }
  if (WRITE_TOOLS.has(toolName)) {
    return decideWrite(input, policy);
  }
  if (toolName === 'Bash') {
    return decideCommand(input, policy.commandAllowlist);
  }
  return { allow: true };
}

/** What a denied network call was aiming at: the URL it fetches or the search it runs. */
function networkTarget(input: Record<string, unknown>): string | undefined {
  if (typeof input['url'] === 'string') {
    return input['url'];
  }
  if (typeof input['query'] === 'string') {
    return input['query'];
  }
  return undefined;
}

function decideWrite(
  input: Record<string, unknown>,
  policy: ToolPolicySpec,
): ToolPermissionDecision {
  if (!policy.allowWrite) {
    return deny('write access is disabled for this agent');
  }
  const filePath = typeof input['file_path'] === 'string' ? input['file_path'] : undefined;
  if (!filePath) {
    return deny('write target is missing');
  }
  const workspaceRoot = resolve(policy.cwd);
  const target = resolve(policy.cwd, filePath);
  if (target !== workspaceRoot && !target.startsWith(workspaceRoot + sep)) {
    return deny(`writes are limited to the task workspace (${workspaceRoot})`);
  }
  return { allow: true };
}

/**
 * Shell words that never need allowlisting: they move around, print, or trim
 * output. `cd` is free because reads are unrestricted anyway and writes are
 * policed by path, not by cwd.
 */
const SAFE_COMMANDS = new Set([
  'cd',
  'echo',
  'printf',
  'true',
  'false',
  'test',
  '[',
  'pwd',
  'head',
  'tail',
  'wc',
  'sort',
  'uniq',
  'cut',
  'tr',
  'cat',
  'ls',
  'xargs',
  'sleep',
  'export',
  'set',
  'exit',
]);
/** Control-flow keywords a compound command is allowed to contain. */
const SHELL_KEYWORDS = new Set([
  'for',
  'do',
  'done',
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'while',
  'until',
  'case',
  'esac',
  'in',
  '{',
  '}',
  '!',
]);

/**
 * The simple commands inside a shell line: split on `;`, `&&`, `||`, `|` and
 * newlines outside quotes, with `$( … )` and backtick substitutions lifted out
 * as commands of their own. Redirections and leading VAR=value assignments are
 * dropped; loop/if keywords are dropped so `for c in …; do git show $c; done`
 * reads as `git show $c`.
 */
export function commandSegments(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let depth = 0; // inside $( … )
  let sub = '';
  let resumeQuote: '"' | null = null; // a $( … ) opened inside double quotes
  const push = (text: string): void => {
    const trimmed = text.trim();
    if (trimmed) {
      segments.push(trimmed);
    }
  };
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] as string;
    const next = command[index + 1];
    if (depth > 0) {
      if (char === '(') {
        depth += 1;
      } else if (char === ')') {
        depth -= 1;
        if (depth === 0) {
          segments.push(...commandSegments(sub));
          sub = '';
          quote = resumeQuote;
          resumeQuote = null;
          continue;
        }
      }
      sub += char;
      continue;
    }
    if (char === '$' && next === '(' && quote !== "'") {
      // substitutions run even inside double quotes - lift the inner command out
      resumeQuote = quote;
      quote = null;
      depth = 1;
      index += 1;
      continue;
    }
    if (char === '`' && quote !== "'") {
      const end = command.indexOf('`', index + 1);
      if (end > index) {
        segments.push(...commandSegments(command.slice(index + 1, end)));
        index = end;
        continue;
      }
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else if (char === '\\' && quote === '"' && next !== undefined) {
        current += char + next;
        index += 1;
        continue;
      }
      current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === '\n' || char === ';' || char === '|' || (char === '&' && next === '&')) {
      push(current);
      current = '';
      if ((char === '|' && next === '|') || char === '&') {
        index += 1;
      }
      continue;
    }
    current += char;
  }
  push(current);
  return segments;
}

/** A segment's command word after redirections, assignments and control keywords are peeled off. */
function commandWordOf(segment: string): { word: string; rest: string } {
  const tokens = segment.split(/\s+/).filter((token) => token.length > 0);
  // `for c in a b` / `case x in` / `select x in` run nothing themselves
  if (tokens[0] === 'for' || tokens[0] === 'case' || tokens[0] === 'select') {
    return { word: '', rest: '' };
  }
  while (tokens.length > 0) {
    const token = tokens[0] as string;
    if (
      SHELL_KEYWORDS.has(token) ||
      /^[A-Za-z_][A-Za-z0-9_]*=/.test(token) ||
      /^\d*[<>]/.test(token)
    ) {
      tokens.shift();
      continue;
    }
    break;
  }
  return { word: tokens[0] ?? '', rest: tokens.join(' ') };
}

function segmentAllowed(segment: string, allowlist: readonly string[]): boolean {
  const { word, rest } = commandWordOf(segment);
  if (word === '' || SAFE_COMMANDS.has(word)) {
    return true;
  }
  const stripped = rest.replace(/\s*\d*[<>]\S*.*$/, ''); // drop trailing redirections
  return allowlist.some(
    (prefix) =>
      stripped === prefix || stripped.startsWith(`${prefix} `) || rest.startsWith(`${prefix} `),
  );
}

function decideCommand(
  input: Record<string, unknown>,
  allowlist: readonly string[],
): ToolPermissionDecision {
  const command = typeof input['command'] === 'string' ? input['command'].trim() : '';
  if (command.length === 0) {
    return deny('command is missing');
  }
  // Every simple command in the line must be allowlisted (or a free shell word) -
  // `cd …; echo …; git show …` is fine when `git show` is; one stray `curl` is not.
  const blocked = commandSegments(command).filter((segment) => !segmentAllowed(segment, allowlist));
  if (blocked.length === 0) {
    return { allow: true };
  }
  // A human may still allow this exact call.
  return {
    ...deny(
      allowlist.length === 0
        ? 'no commands are allowlisted for this agent'
        : `not in this agent's allowlist: ${blocked.join(' · ')} - allowed: ${allowlist.join(', ')} (plus cd/echo/head/tail/wc/sort and control flow)`,
    ),
    escalatable: true,
    detail: command,
  };
}

function deny(reason: string): ToolPermissionDecision {
  return { allow: false, reason };
}
