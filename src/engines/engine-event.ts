export interface EngineUsage {
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly costUsd?: number;
}

export type EngineEvent =
  | { readonly type: 'text-delta'; readonly text: string }
  /** Streaming fragment of the text block currently being written; the complete block still follows as a text-delta. */
  | { readonly type: 'text-partial'; readonly text: string }
  | {
      readonly type: 'tool-call';
      readonly callId: string;
      readonly toolName: string;
      readonly input: unknown;
    }
  | {
      readonly type: 'tool-result';
      readonly callId: string;
      readonly output: unknown;
      readonly isError: boolean;
    }
  | { readonly type: 'usage'; readonly usage: EngineUsage }
  | { readonly type: 'done'; readonly report?: unknown }
  | {
      readonly type: 'error';
      readonly message: string;
      /** A usage/rate limit, not a real failure - the orchestrator won't retry it. */
      readonly isQuotaError?: boolean;
      /** ISO timestamp the limit is expected to lift, when the engine's message named one. */
      readonly retryAt?: string;
      /** The engine's login expired or is missing - stop, let the user sign in, resume. */
      readonly isAuthError?: boolean;
    };
