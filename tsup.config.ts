import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

const manifest = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  dependencies?: Record<string, string>;
};
const external = Object.keys(manifest.dependencies ?? {});

export default defineConfig([
  {
    entry: { index: 'src/index.ts', cli: 'src/main.ts' },
    format: ['esm'],
    platform: 'node',
    target: 'node22',
    splitting: true,
    sourcemap: true,
    clean: true,
    outExtension: () => ({ js: '.mjs' }),
    external,
  },
  {
    // Built for the browser so a Node import leaking into the definition model fails the build.
    entry: { definitions: 'src/definitions/index.ts' },
    format: ['esm'],
    platform: 'browser',
    target: 'es2022',
    sourcemap: true,
    outExtension: () => ({ js: '.mjs' }),
    external,
  },
]);
