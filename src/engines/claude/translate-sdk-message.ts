import type { EngineEvent } from '../engine-event';
import { isAuthFailure } from '../auth-error';
import { errorEventOf } from '../quota-error';
import { parseTrailingJsonReport } from './parse-trailing-json-report';

/**
 * Structural translation of Claude Agent SDK stream messages into EngineEvents.
 * Deliberately defensive: unknown message shapes translate to nothing instead
 * of throwing, so SDK additions never break a running session.
 */
export function translateSdkMessage(message: unknown): EngineEvent[] {
  if (!isRecord(message) || typeof message['type'] !== 'string') {
    return [];
  }
  switch (message['type']) {
    case 'assistant':
      return translateAssistant(message);
    case 'user':
      return translateUser(message);
    case 'result':
      return translateResult(message);
    case 'stream_event':
      return translateStreamEvent(message);
    default:
      return [];
  }
}

/** Live typing: only main-stream text deltas - the complete block still arrives as an assistant message. */
function translateStreamEvent(message: Record<string, unknown>): EngineEvent[] {
  if (message['parent_tool_use_id']) {
    return []; // a subagent's stream, not ours
  }
  const event = message['event'];
  if (!isRecord(event) || event['type'] !== 'content_block_delta') {
    return [];
  }
  const delta = event['delta'];
  if (!isRecord(delta) || delta['type'] !== 'text_delta' || typeof delta['text'] !== 'string') {
    return [];
  }
  return [{ type: 'text-partial', text: delta['text'] }];
}

function translateAssistant(message: Record<string, unknown>): EngineEvent[] {
  const blocks = contentBlocksOf(message);
  // An expired login comes back as the whole reply: one short text block, no tools.
  const only = blocks.length === 1 ? blocks[0] : undefined;
  if (
    only &&
    only['type'] === 'text' &&
    typeof only['text'] === 'string' &&
    isAuthFailure(only['text'])
  ) {
    return [errorEventOf(only['text'])];
  }
  const events: EngineEvent[] = [];
  for (const block of blocks) {
    if (block['type'] === 'text' && typeof block['text'] === 'string') {
      events.push({ type: 'text-delta', text: block['text'] });
    }
    if (
      block['type'] === 'tool_use' &&
      typeof block['id'] === 'string' &&
      typeof block['name'] === 'string'
    ) {
      events.push({
        type: 'tool-call',
        callId: block['id'],
        toolName: block['name'],
        input: block['input'],
      });
    }
  }
  return events;
}

function translateUser(message: Record<string, unknown>): EngineEvent[] {
  const events: EngineEvent[] = [];
  for (const block of contentBlocksOf(message)) {
    if (block['type'] === 'tool_result' && typeof block['tool_use_id'] === 'string') {
      events.push({
        type: 'tool-result',
        callId: block['tool_use_id'],
        output: block['content'],
        isError: block['is_error'] === true,
      });
    }
  }
  return events;
}

function translateResult(message: Record<string, unknown>): EngineEvent[] {
  const events: EngineEvent[] = [];
  const usage = isRecord(message['usage']) ? message['usage'] : undefined;
  if (usage) {
    events.push({
      type: 'usage',
      usage: {
        tokensIn: numberOr(usage['input_tokens'], 0),
        tokensOut: numberOr(usage['output_tokens'], 0),
        cacheReadTokens: numberOr(usage['cache_read_input_tokens'], 0),
        cacheWriteTokens: numberOr(usage['cache_creation_input_tokens'], 0),
        ...(typeof message['total_cost_usd'] === 'number'
          ? { costUsd: message['total_cost_usd'] }
          : {}),
      },
    });
  }

  const resultText = typeof message['result'] === 'string' ? message['result'] : '';
  if (message['is_error'] === true || isAuthFailure(resultText)) {
    events.push(
      errorEventOf(resultText || `Engine run ended with '${String(message['subtype'])}'`),
    );
  } else if (message['subtype'] === 'success') {
    const report = parseTrailingJsonReport(resultText);
    events.push(report === undefined ? { type: 'done' } : { type: 'done', report });
  } else {
    events.push(
      errorEventOf(
        `Engine run ended with '${String(message['subtype'])}'${resultText ? `: ${resultText}` : ''}`,
      ),
    );
  }
  return events;
}

function contentBlocksOf(message: Record<string, unknown>): Record<string, unknown>[] {
  const inner = message['message'];
  if (!isRecord(inner) || !Array.isArray(inner['content'])) {
    return [];
  }
  return inner['content'].filter(isRecord);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' ? value : fallback;
}
