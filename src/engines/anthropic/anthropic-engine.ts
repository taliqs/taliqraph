import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { engineAuthEnvironment } from '../engine-environment';
import type {
  EngineAdapter,
  EngineAuthStatus,
  EngineCapabilities,
  EngineRunSpec,
  EngineSession,
} from '../engine-adapter';
import type { EngineEvent } from '../engine-event';
import { AsyncQueue } from '../utils/async-queue';
import { CLAUDE_MODELS, resolveClaudeModelId } from './claude-models';
import { effortToThinkingTokens } from './effort-to-thinking-tokens';
import { readAuthStatus } from './read-auth-status';
import { errorEventOf } from '../quota-error';
import type { ToolPermissionDecision } from './tool-permission-policy';
import { decideToolPermission } from './tool-permission-policy';
import { translateSdkMessage } from './translate-sdk-message';

export type ClaudeQueryFn = (args: {
  prompt: AsyncIterable<Record<string, unknown>>;
  options: Record<string, unknown>;
}) => AsyncIterable<unknown>;

export interface AnthropicEngineOptions {
  /** Injectable for tests; defaults to the Claude Agent SDK's query(). */
  readonly queryFn?: ClaudeQueryFn;
  readonly authConfigFilePath?: string;
}

async function* sdkQuery(args: {
  prompt: AsyncIterable<Record<string, unknown>>;
  options: Record<string, unknown>;
}): AsyncIterable<unknown> {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  yield* query(args as never) as AsyncIterable<unknown>;
}

export class AnthropicEngine implements EngineAdapter {
  readonly id = 'anthropic';
  readonly label = 'Anthropic';
  private readonly queryFn: ClaudeQueryFn;
  private readonly authConfigFilePath: string;

  constructor(options: AnthropicEngineOptions = {}) {
    this.queryFn = options.queryFn ?? sdkQuery;
    this.authConfigFilePath = options.authConfigFilePath ?? join(homedir(), '.claude.json');
  }

  capabilities(): EngineCapabilities {
    return {
      models: CLAUDE_MODELS,
      effort: true,
      mcp: true,
      permissionCallbacks: true,
      resume: true,
    };
  }

  authStatus(): Promise<EngineAuthStatus> {
    return readAuthStatus(this.authConfigFilePath);
  }

  startSession(spec: EngineRunSpec): EngineSession {
    return new ClaudeCodeSession(spec, this.queryFn);
  }
}

class ClaudeCodeSession implements EngineSession {
  readonly id = randomUUID();
  private readonly input = new AsyncQueue<Record<string, unknown>>();
  private readonly abort = new AbortController();

  constructor(
    private readonly spec: EngineRunSpec,
    private readonly queryFn: ClaudeQueryFn,
  ) {
    this.input.push(toSdkUserMessage(spec.userMessage));
  }

  async *events(): AsyncIterable<EngineEvent> {
    try {
      const stream = this.queryFn({
        prompt: this.input,
        options: buildQueryOptions(this.spec, this.abort),
      });
      for await (const message of stream) {
        yield* translateSdkMessage(message);
      }
    } catch (cause) {
      if (!this.abort.signal.aborted) {
        yield errorEventOf(messageOf(cause));
      }
    } finally {
      this.input.close();
    }
  }

  send(message: string): void {
    this.input.push(toSdkUserMessage(message));
  }

  cancel(): void {
    this.abort.abort();
    this.input.close();
  }
}

function buildQueryOptions(spec: EngineRunSpec, abort: AbortController): Record<string, unknown> {
  const thinkingTokens = spec.effort ? effortToThinkingTokens(spec.effort) : undefined;
  const mcpServers = Object.fromEntries(
    (spec.mcpServers ?? []).map((server) => [
      server.name,
      server.kind === 'stdio'
        ? {
            type: 'stdio',
            command: server.command,
            ...(server.args?.length ? { args: [...server.args] } : {}),
            ...(server.env ? { env: { ...server.env } } : {}),
          }
        : {
            type: 'http',
            url: server.url,
            ...(server.headers && Object.keys(server.headers).length > 0
              ? { headers: { ...server.headers } }
              : {}),
          },
    ]),
  );
  return {
    ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
    systemPrompt: spec.systemPrompt,
    model: resolveClaudeModelId(spec.model),
    cwd: spec.cwd,
    // A clean environment replaces the host's entirely; the engine's own
    // auth variables ride along so the login keeps working.
    ...(spec.env ? { env: { ...spec.env, ...engineAuthEnvironment() } } : {}),
    ...(thinkingTokens !== undefined ? { maxThinkingTokens: thinkingTokens } : {}),
    // Agents are fully defined by their Taliqraph definition - never by
    // whatever CLAUDE.md / settings happen to exist on this machine.
    settingSources: [],
    // live typing in the task feed; off when the host says it shows none
    includePartialMessages: spec.streamText !== false,
    abortController: abort,
    canUseTool: async (toolName: string, input: Record<string, unknown>) => {
      const decision = decideToolPermission(toolName, input, spec);
      if (decision.allow) {
        return { behavior: 'allow' as const, updatedInput: input };
      }
      if (decision.escalatable && spec.onPermissionRequest) {
        const granted = await spec
          .onPermissionRequest({ toolName, detail: decision.detail ?? toolName })
          .catch(() => false);
        if (granted) {
          return { behavior: 'allow' as const, updatedInput: input };
        }
        return { behavior: 'deny' as const, message: refusal(decision, toolName) };
      }
      return { behavior: 'deny' as const, message: refusal(decision, toolName) };
    },
  };
}

/**
 * What a refused call tells the model. The reason carries the allowlist, which
 * is the thing it needs to choose another way - the old message dropped it and
 * said only that someone declined, which left the model guessing and retrying
 * variations of the same blocked command.
 */
function refusal(decision: ToolPermissionDecision, toolName: string): string {
  const reason = decision.reason ?? `${toolName} is not permitted for this agent`;
  return `Refused: ${reason}. Do not retry it or route around it with another command. If you cannot finish without it, say so in your report and do what you can without it.`;
}

function toSdkUserMessage(text: string): Record<string, unknown> {
  return {
    type: 'user',
    message: { role: 'user', content: text },
    parent_tool_use_id: null,
    session_id: '',
  };
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
