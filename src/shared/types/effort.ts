export const EFFORT_LEVELS = ['low', 'med', 'high', 'max'] as const;

export type EffortLevel = (typeof EFFORT_LEVELS)[number];
