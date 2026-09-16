import type { EffortLevel } from '../shared/types/effort';
import type { EngineEvent } from './engine-event';

export interface ModelInfo {
  readonly id: string;
  readonly label: string;
}

export interface EngineCapabilities {
  readonly models: readonly ModelInfo[];
  readonly effort: boolean;
  readonly mcp: boolean;
  readonly permissionCallbacks: boolean;
  readonly resume: boolean;
}

export type EngineAuthStatus =
  | { readonly state: 'authenticated'; readonly account?: string }
  /** Signed in once, but the session lapsed and cannot refresh - sign in again. */
  | { readonly state: 'expired'; readonly account?: string }
  | { readonly state: 'unauthenticated' }
  /** The engine's CLI is not on this machine at all - install, then sign in. */
  | { readonly state: 'not-installed' }
  | { readonly state: 'unknown' };

/** One configured MCP server: stdio commands or remote HTTP/SSE. */
export type McpServerSpec =
  | {
      readonly name: string;
      readonly kind: 'stdio';
      readonly command: string;
      readonly args?: readonly string[];
      readonly env?: Readonly<Record<string, string>>;
    }
  | {
      readonly name: string;
      readonly kind: 'http';
      readonly url: string;
      /** Resolved request headers (bearer tokens, API keys) - values, never references. */
      readonly headers?: Readonly<Record<string, string>>;
    };

export interface EngineRunSpec {
  readonly systemPrompt: string;
  readonly userMessage: string;
  readonly model: string;
  readonly effort?: EffortLevel;
  readonly cwd: string;
  readonly allowWrite: boolean;
  /** Agent's network knob: WebSearch/WebFetch allowed when true. */
  readonly allowNetwork?: boolean;
  readonly commandAllowlist: readonly string[];
  /**
   * The session process's whole environment: the clean base, the
   * workflow's pass-through and the step's secrets. Absent = inherit the host's.
   * Adapters add their own auth variables on top (engineAuthEnvironment).
   */
  readonly env?: Readonly<Record<string, string>>;
  /** MCP servers this run may use - only the agent's allowlisted ones arrive here. */
  readonly mcpServers?: readonly McpServerSpec[];
  /**
   * Escalation hook: called when the agent wants something its
   * policy denies but a human may allow (a command off the allowlist, network
   * access). Resolve true to allow this one call. Absent = plain denial.
   */
  readonly onPermissionRequest?: (request: PermissionRequest) => Promise<boolean>;
}

export interface PermissionRequest {
  readonly toolName: string;
  /** Human-readable subject: the command line, the URL, … */
  readonly detail: string;
}

export interface EngineSession {
  readonly id: string;
  events(): AsyncIterable<EngineEvent>;
  send(message: string): void;
  cancel(): void;
}

export interface EngineAdapter {
  readonly id: string;
  readonly label: string;
  capabilities(): EngineCapabilities;
  authStatus(): Promise<EngineAuthStatus>;
  startSession(spec: EngineRunSpec): EngineSession;
}
