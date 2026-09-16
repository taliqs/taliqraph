import { sleep } from '../../shared/utils/sleep';
import type {
  EngineAdapter,
  EngineAuthStatus,
  EngineCapabilities,
  EngineRunSpec,
  EngineSession,
} from '../engine-adapter';
import type { EngineEvent } from '../engine-event';

export interface MockEngineOptions {
  readonly script?: readonly EngineEvent[];
  readonly delayMs?: number;
}

/**
 * A test agent can script its own report: a line `Report {"…"}` anywhere in the
 * system prompt (the agent's body) becomes the done report - so token-free
 * workflows still produce findings, flags and lists for the steps after them.
 */
function scriptedReport(spec: EngineRunSpec): unknown {
  const match = /^Report ([{].*[}])[ \t\r]*$/m.exec(spec.systemPrompt);
  if (!match?.[1]) {
    return { summary: 'mock run complete' };
  }
  try {
    return JSON.parse(match[1]) as unknown;
  } catch {
    return { summary: 'mock run complete' };
  }
}

function defaultScript(spec: EngineRunSpec): readonly EngineEvent[] {
  return [
    { type: 'text-delta', text: `Working on: ${spec.userMessage}` },
    { type: 'text-delta', text: ' … done.' },
    {
      type: 'usage',
      usage: { tokensIn: 120, tokensOut: 48, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
    { type: 'done', report: scriptedReport(spec) },
  ];
}

class MockEngineSession implements EngineSession {
  readonly id: string;
  readonly sentMessages: string[] = [];
  private cancelled = false;

  constructor(
    id: string,
    private readonly script: readonly EngineEvent[],
    private readonly delayMs: number,
  ) {
    this.id = id;
  }

  async *events(): AsyncIterable<EngineEvent> {
    for (const event of this.script) {
      if (this.cancelled) {
        return;
      }
      if (this.delayMs > 0) {
        await sleep(this.delayMs);
      }
      yield event;
    }
  }

  send(message: string): void {
    this.sentMessages.push(message);
  }

  cancel(): void {
    this.cancelled = true;
  }
}

export class MockEngine implements EngineAdapter {
  readonly id = 'mock';
  readonly label = 'Mock Engine';
  private sessionCounter = 0;

  constructor(private readonly options: MockEngineOptions = {}) {}

  capabilities(): EngineCapabilities {
    return {
      models: [{ id: 'mock-model', label: 'Mock Model' }],
      effort: true,
      mcp: false,
      permissionCallbacks: true,
      resume: false,
    };
  }

  authStatus(): Promise<EngineAuthStatus> {
    return Promise.resolve({ state: 'authenticated', account: 'mock@local' });
  }

  startSession(spec: EngineRunSpec): MockEngineSession {
    this.sessionCounter += 1;
    return new MockEngineSession(
      `mock-session-${this.sessionCounter}`,
      this.options.script ?? defaultScript(spec),
      this.options.delayMs ?? 0,
    );
  }
}
