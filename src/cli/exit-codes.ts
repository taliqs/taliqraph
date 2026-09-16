/** 0 ok · 1 error · 2 lint problems / usage · 3 stopped at a gate · 4 over budget (headless) · 130 interrupted. */
export const EXIT = {
  ok: 0,
  error: 1,
  problems: 2,
  gate: 3,
  budget: 4,
  interrupted: 130,
} as const;
