import type { EngineEvent } from '../engine-event';
import { parseTrailingJsonReport } from '../claude/parse-trailing-json-report';
import { errorEventOf } from '../quota-error';

export interface CodexTranslationState {
  lastAgentMessage: string;
  done?: boolean;
  /** Model of the run - codex reports no cost, so we price its tokens locally. */
  model?: string;
}

/**
 * USD per million tokens (OpenAI list prices, checked 2026-09). Codex sends
 * token counts but no cost; unknown models fall back to gpt-5 rates rather
 * than recording a silent $0.
 */
const CODEX_PRICING: Readonly<
  Record<string, { input: number; cachedInput: number; output: number }>
> = {
  'gpt-5': { input: 1.25, cachedInput: 0.125, output: 10 },
  'gpt-5-codex': { input: 1.25, cachedInput: 0.125, output: 10 },
  'gpt-5-mini': { input: 0.25, cachedInput: 0.025, output: 2 },
};

export function codexCostUsd(
  model: string | undefined,
  tokensIn: number,
  cachedIn: number,
  tokensOut: number,
): number {
  const rates = CODEX_PRICING[model ?? ''] ?? CODEX_PRICING['gpt-5']!;
  const freshIn = Math.max(0, tokensIn - cachedIn);
  return (
    (freshIn * rates.input + cachedIn * rates.cachedInput + tokensOut * rates.output) / 1_000_000
  );
}

/**
 * One JSONL line from `codex exec --json` → engine events. Handles the typed
 * thread shape (`item.completed` / `turn.completed`) and tolerates the older
 * `{"msg":{"type":…}}` envelope; unknown lines are ignored rather than fatal.
 */
export function translateCodexLine(line: string, state: CodexTranslationState): EngineEvent[] {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return [];
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return [];
  }
  // Older envelope: {"id":"0","msg":{"type":"agent_message","message":"…"}}
  const envelope = parsed['msg'];
  const payload =
    typeof envelope === 'object' && envelope !== null
      ? (envelope as Record<string, unknown>)
      : parsed;
  const type = String(payload['type'] ?? '');

  switch (type) {
    case 'item.started': {
      const item = itemOf(payload);
      if (item?.['type'] === 'command_execution') {
        return [
          {
            type: 'tool-call',
            callId: String(item['id'] ?? 'codex-cmd'),
            toolName: 'Bash',
            input: { command: String(item['command'] ?? '') },
          },
        ];
      }
      return [];
    }
    case 'item.completed': {
      const item = itemOf(payload);
      if (!item) {
        return [];
      }
      if (item['type'] === 'agent_message') {
        const text = String(item['text'] ?? '');
        state.lastAgentMessage = text;
        return [{ type: 'text-delta', text }];
      }
      if (item['type'] === 'command_execution') {
        return [
          {
            type: 'tool-result',
            callId: String(item['id'] ?? 'codex-cmd'),
            output: String(item['aggregated_output'] ?? '').slice(0, 2000),
            isError: Number(item['exit_code'] ?? 0) !== 0,
          },
        ];
      }
      return [];
    }
    case 'agent_message': {
      // Older envelope carries the text directly.
      const text = String(payload['message'] ?? payload['text'] ?? '');
      state.lastAgentMessage = text;
      return [{ type: 'text-delta', text }];
    }
    case 'turn.completed': {
      const usage = payload['usage'] as Record<string, unknown> | undefined;
      const events: EngineEvent[] = [];
      if (usage) {
        const tokensIn = Number(usage['input_tokens'] ?? 0);
        const tokensOut = Number(usage['output_tokens'] ?? 0);
        const cachedIn = Number(usage['cached_input_tokens'] ?? 0);
        events.push({
          type: 'usage',
          usage: {
            tokensIn,
            tokensOut,
            cacheReadTokens: cachedIn,
            cacheWriteTokens: 0,
            costUsd: codexCostUsd(state.model, tokensIn, cachedIn, tokensOut),
          },
        });
      }
      const report = parseTrailingJsonReport(state.lastAgentMessage);
      events.push({ type: 'done', ...(report !== undefined ? { report } : {}) });
      state.done = true;
      return events;
    }
    case 'turn.failed':
    case 'error': {
      const error = payload['error'] as Record<string, unknown> | undefined;
      state.done = true;
      return [errorEventOf(String(error?.['message'] ?? payload['message'] ?? 'codex failed'))];
    }
    default:
      return [];
  }
}

function itemOf(payload: Record<string, unknown>): Record<string, unknown> | null {
  const item = payload['item'];
  return typeof item === 'object' && item !== null ? (item as Record<string, unknown>) : null;
}
