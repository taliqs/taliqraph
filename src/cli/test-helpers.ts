import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CliContext } from './context';
import { Output } from './output';

/** A context over a scratch folder whose output lands in `lines` / `errors` instead of the terminal. */
export interface ScratchContext extends CliContext {
  readonly lines: string[];
  readonly errors: string[];
}

export async function scratchContext(): Promise<ScratchContext> {
  const base = await mkdtemp(join(tmpdir(), 'tq-cli-'));
  const cwd = join(base, 'work');
  await mkdir(cwd, { recursive: true });
  const lines: string[] = [];
  const errors: string[] = [];
  const out = new Output(
    { json: false, quiet: false, color: false },
    {
      out: (text) => lines.push(...text.replace(/\n$/, '').split('\n')),
      err: (text) => errors.push(text.replace(/\n$/, '')),
    },
  );
  return { cwd, out, lines, errors };
}

/** Writes `files` (relative path to content) under `root`, creating folders on the way. */
export async function writeTree(
  root: string,
  files: Readonly<Record<string, string>>,
): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, ...path.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}

/** An agent on the mock engine whose report is scripted. */
export function mockAgent(name: string, report: unknown = { summary: 'worked' }): string {
  return [
    '---',
    `name: ${name}`,
    'description: A test agent.',
    'engine: mock',
    'model: mock-model',
    '---',
    `You are ${name}.`,
    `Report ${JSON.stringify(report)}`,
    '',
  ].join('\n');
}

export const ONE_STEP_WORKFLOW = [
  'name: one-step',
  'title: One Step',
  'steps:',
  '  - id: work',
  '    agent: worker',
  '    input: []',
  '    output: result',
  '',
].join('\n');
