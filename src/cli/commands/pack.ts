import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { Command } from 'commander';
import { buildPackageTqh, lintBundleSecrets, TQH_EXTENSION } from '../../bundles/tqh';
import { readBundleSource } from '../../packages/read-package';
import type { CliContext, GlobalOptions } from '../context';
import { withCli } from '../context';
import { EXIT } from '../exit-codes';

/** `pack <folder>`: the package folder as one file; `unpack <file>`: the file as a folder again. */
export function registerPackCommands(program: Command, globals: () => GlobalOptions): void {
  program
    .command('pack <folder>')
    .description(`write a workflow package folder as a single ${TQH_EXTENSION} file`)
    .option(
      '--file <path>',
      `where to write it (default: <folder name>${TQH_EXTENSION} beside the folder)`,
    )
    .action((folder: string, options: { file?: string }) =>
      withCli(globals(), (context) => packCommand(context, folder, options)),
    );
  program
    .command('unpack <file>')
    .description(`write a ${TQH_EXTENSION} file out as a package folder`)
    .option('--to <dir>', 'the parent folder to unpack into (default: the current folder)')
    .action((file: string, options: { to?: string }) =>
      withCli(globals(), (context) => unpackCommand(context, file, options)),
    );
}

export async function packCommand(
  context: CliContext,
  folder: string,
  options: { file?: string },
): Promise<void> {
  const dir = resolve(context.cwd, folder);
  const read = existsSync(dir) ? await readBundleSource(dir) : null;
  if (
    !read ||
    (!existsSync(join(dir, 'workflow.yaml')) && !existsSync(join(dir, 'workflow.yml')))
  ) {
    throw new Error(`${folder} is not a workflow package folder (no workflow.yaml inside)`);
  }
  const findings = lintBundleSecrets(
    read.files.map((file) => ({ name: file.path, source: file.content })),
  );
  if (findings.length > 0) {
    context.out.error(
      `refusing to pack: ${findings.map((finding) => `${finding.name} holds ${finding.kind} (${finding.match})`).join('; ')}`,
    );
    process.exitCode = EXIT.problems;
    return;
  }
  const target = resolve(
    context.cwd,
    options.file ?? join(dirname(dir), `${basename(dir)}${TQH_EXTENSION}`),
  );
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, buildPackageTqh(read.name, read.files));
  context.out.result(
    { name: read.name, path: target, files: read.files.length },
    () =>
      `${read.name}: ${read.files.length} file${read.files.length === 1 ? '' : 's'} into ${target}`,
  );
  process.exitCode = EXIT.ok;
}

export async function unpackCommand(
  context: CliContext,
  file: string,
  options: { to?: string },
): Promise<void> {
  const path = resolve(context.cwd, file);
  const read = existsSync(path) ? await readBundleSource(path) : null;
  if (!read) {
    throw new Error(`${file} is not a ${TQH_EXTENSION} package file`);
  }
  const dir = join(resolve(context.cwd, options.to ?? '.'), read.name);
  if (existsSync(dir)) {
    throw new Error(`${dir} already exists`);
  }
  for (const entry of read.files) {
    const target = join(dir, ...entry.path.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, entry.content);
  }
  context.out.result(
    { name: read.name, path: dir, files: read.files.length },
    () =>
      `${read.name}: ${read.files.length} file${read.files.length === 1 ? '' : 's'} into ${dir}`,
  );
  process.exitCode = EXIT.ok;
}
