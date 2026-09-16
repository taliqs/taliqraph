import { defineConfig } from 'vitest/config';

// Run and worktree tests shell out to git in scratch repositories; under full-suite load they pass 5s.
export default defineConfig({
  test: { testTimeout: 20_000 },
});
