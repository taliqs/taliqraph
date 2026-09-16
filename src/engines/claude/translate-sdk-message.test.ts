import { describe, expect, it } from 'vitest';
import { translateSdkMessage } from './translate-sdk-message';

describe('translateSdkMessage', () => {
  it('translates assistant text and tool_use blocks', () => {
    const events = translateSdkMessage({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Fixing the timer now.' },
          { type: 'tool_use', id: 'call-1', name: 'Edit', input: { file_path: 'a.ts' } },
        ],
      },
    });
    expect(events).toEqual([
      { type: 'text-delta', text: 'Fixing the timer now.' },
      { type: 'tool-call', callId: 'call-1', toolName: 'Edit', input: { file_path: 'a.ts' } },
    ]);
  });

  it('translates tool results', () => {
    const events = translateSdkMessage({
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'ok', is_error: false }],
      },
    });
    expect(events).toEqual([
      { type: 'tool-result', callId: 'call-1', output: 'ok', isError: false },
    ]);
  });

  it('translates a success result into usage + done with a parsed report', () => {
    const events = translateSdkMessage({
      type: 'result',
      subtype: 'success',
      result: 'All done.\n```json\n{"filesChanged": 2}\n```',
      total_cost_usd: 0.042,
      usage: {
        input_tokens: 1200,
        output_tokens: 340,
        cache_read_input_tokens: 900,
        cache_creation_input_tokens: 100,
      },
    });
    expect(events).toEqual([
      {
        type: 'usage',
        usage: {
          tokensIn: 1200,
          tokensOut: 340,
          cacheReadTokens: 900,
          cacheWriteTokens: 100,
          costUsd: 0.042,
        },
      },
      { type: 'done', report: { filesChanged: 2 } },
    ]);
  });

  it('translates a failed result into usage + error', () => {
    const events = translateSdkMessage({
      type: 'result',
      subtype: 'error_max_turns',
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    expect(events[0]?.type).toBe('usage');
    expect(events[1]).toEqual({
      type: 'error',
      message: "Engine run ended with 'error_max_turns'",
    });
  });

  it('translates streaming text deltas into text-partial', () => {
    const events = translateSdkMessage({
      type: 'stream_event',
      parent_tool_use_id: null,
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Fix' } },
    });
    expect(events).toEqual([{ type: 'text-partial', text: 'Fix' }]);
  });

  it('ignores non-text stream events and subagent streams', () => {
    expect(
      translateSdkMessage({
        type: 'stream_event',
        parent_tool_use_id: null,
        event: {
          type: 'content_block_delta',
          delta: { type: 'input_json_delta', partial_json: '{' },
        },
      }),
    ).toEqual([]);
    expect(
      translateSdkMessage({
        type: 'stream_event',
        parent_tool_use_id: null,
        event: { type: 'message_start' },
      }),
    ).toEqual([]);
    expect(
      translateSdkMessage({
        type: 'stream_event',
        parent_tool_use_id: 'tool-123',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'sub' } },
      }),
    ).toEqual([]);
  });

  it('ignores unknown or malformed messages', () => {
    expect(translateSdkMessage({ type: 'system', subtype: 'init' })).toEqual([]);
    expect(translateSdkMessage('nonsense')).toEqual([]);
    expect(translateSdkMessage({ type: 'assistant', message: { content: 'text' } })).toEqual([]);
  });
});

describe('translateSdkMessage - sign-in failures', () => {
  it("turns Claude Code's expired-login reply into an auth error instead of agent text", () => {
    const events = translateSdkMessage({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'text',
            text: 'Failed to authenticate: OAuth session expired and could not be refreshed',
          },
        ],
      },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', isAuthError: true });
    expect(events[0]).toHaveProperty('message', expect.stringContaining('sign in again'));
  });

  it('keeps a real reply that merely mentions authentication', () => {
    const events = translateSdkMessage({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'text',
            text: 'The login flow failed to authenticate users whose session expired; I fixed the refresh.',
          },
        ],
      },
    });
    expect(events[0]).toMatchObject({ type: 'text-delta' });
  });

  it('treats an is_error result as an error even when the subtype says success', () => {
    const events = translateSdkMessage({
      type: 'result',
      subtype: 'success',
      is_error: true,
      result: 'Not logged in. Please run /login',
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    expect(events.at(-1)).toMatchObject({ type: 'error', isAuthError: true });
  });
});
