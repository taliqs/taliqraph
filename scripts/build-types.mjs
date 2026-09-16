#!/usr/bin/env node
// Emits declarations for both entries, then gives relative specifiers the .js
// extension ESM resolution expects so the output stands alone.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(rootDir, 'dist', 'types');

execFileSync('pnpm', ['exec', 'tsc', '-p', 'tsconfig.types.json'], {
  cwd: rootDir,
  stdio: 'inherit',
});

function withExtension(specifier, file) {
  if (/\.(js|mjs|cjs|json)$/.test(specifier)) {
    return specifier;
  }
  const target = join(dirname(file), specifier);
  if (existsSync(`${target}.d.ts`)) {
    return `${specifier}.js`;
  }
  if (existsSync(join(target, 'index.d.ts'))) {
    return `${specifier}/index.js`;
  }
  return specifier;
}

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : path.endsWith('.d.ts') ? [path] : [];
  });
}

const files = walk(outDir);
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const rewritten = text.replace(
    /(from\s+|import\()(['"])([^'"]+)\2/g,
    (_match, lead, quote, specifier) =>
      `${lead}${quote}${specifier.startsWith('.') ? withExtension(specifier, file) : specifier}${quote}`,
  );
  if (rewritten !== text) {
    writeFileSync(file, rewritten);
  }
}
console.log(`types: ${files.length} declaration files under dist/types`);
