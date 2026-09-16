import type { EffortLevel } from '../../shared/types/effort';

const THINKING_TOKENS: Readonly<Record<EffortLevel, number | undefined>> = {
  low: undefined,
  med: 4_000,
  high: 12_000,
  max: 31_999,
};

export function effortToThinkingTokens(effort: EffortLevel): number | undefined {
  return THINKING_TOKENS[effort];
}
