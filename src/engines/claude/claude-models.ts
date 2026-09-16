import type { ModelInfo } from '../engine-adapter';

export const CLAUDE_MODELS: readonly ModelInfo[] = [
  { id: 'sonnet-5', label: 'Sonnet 5' },
  { id: 'opus-5', label: 'Opus 5' },
  { id: 'haiku-4-5', label: 'Haiku 4.5' },
];

const MODEL_ID_MAP: Readonly<Record<string, string>> = {
  'sonnet-5': 'claude-sonnet-5',
  'opus-5': 'claude-opus-5',
  'haiku-4-5': 'claude-haiku-4-5-20251001',
};

/** Normalized model id → Claude API model id. Unknown ids pass through untouched. */
export function resolveClaudeModelId(modelId: string): string {
  return MODEL_ID_MAP[modelId] ?? modelId;
}
