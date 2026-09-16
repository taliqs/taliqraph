#!/usr/bin/env node
// Published: the bundled CLI in dist/. In the workspace: the TypeScript sources through tsx.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const bundled = new URL('../dist/cli.mjs', import.meta.url);
if (existsSync(bundled)) {
  await import(bundled.href);
} else {
  // tsx looks for a tsconfig next to the cwd; this package's lives here.
  process.env.TSX_TSCONFIG_PATH ??= fileURLToPath(new URL('../tsconfig.json', import.meta.url));
  const { register } = await import('tsx/esm/api');
  register();
  await import('../src/main.ts');
}
