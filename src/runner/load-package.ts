import { TQH_EXTENSION } from '../bundles/tqh';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import type { DefinitionProblem, ResolvedDefinitions } from '../definitions/definition-set';
import type { WorkflowDefinition } from '../definitions/workflow/workflow-definition';
import { buildDefinitionSet, packageScope } from '../definitions/definition-set';
import { readPackage } from '../packages/load-definition-sources';
import { readBundleSource } from '../packages/read-package';

export interface LoadedPackage {
  readonly name: string;
  readonly workflow: WorkflowDefinition;
  /** What the run resolves against: the package's members and nested packages. */
  readonly scope: ResolvedDefinitions;
  /** The package folder the files were read from. */
  readonly dir: string;
  /** Files in the package that did not parse; each one is an error a run or a lint reports. */
  readonly problems: readonly DefinitionProblem[];
}

const PACKAGE_MANIFESTS = ['workflow.yaml', 'workflow.yml'];

/**
 * One package, straight from disk: a package folder, or a bundle file unpacked
 * into a scratch folder so its scripts have a directory to run from.
 */
export async function loadPackage(source: string): Promise<LoadedPackage> {
  const path = resolve(source);
  const read = existsSync(path) ? await readBundleSource(path) : null;
  if (!read) {
    throw new Error(
      `${source} is not a workflow package: expected a folder with workflow.yaml, or a ${TQH_EXTENSION} file`,
    );
  }
  const dir = PACKAGE_MANIFESTS.some((manifest) => existsSync(join(path, manifest)))
    ? path
    : await unpackBundle(read.name, read.files);
  return loadFromDir(dir, read.name, source);
}

async function loadFromDir(dir: string, name: string, source: string): Promise<LoadedPackage> {
  const sources = await readPackage(dir, 'global', [name]);
  if (sources.length === 0) {
    throw new Error(`${source} holds no workflow package: expected workflow.yaml inside`);
  }
  const set = buildDefinitionSet(sources);
  const scope = packageScope(set, name);
  const workflow = scope.workflows.get(name);
  if (!workflow) {
    throw new Error(describeProblems(name, dir, set.problems));
  }
  return { name, workflow, scope, dir, problems: set.problems };
}

async function unpackBundle(
  name: string,
  files: ReadonlyArray<{ readonly path: string; readonly content: string }>,
): Promise<string> {
  const dir = join(await mkdtemp(join(tmpdir(), `taliqraph-package-`)), name);
  for (const file of files) {
    const target = join(dir, ...file.path.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.content);
  }
  return dir;
}

/**
 * Why a package would not load, as short as it can be said: the files that are
 * wrong, each with its own problems under it, paths relative to the package.
 */
export function describeProblems(
  name: string,
  dir: string,
  problems: readonly DefinitionProblem[],
): string {
  // the package's own manifest failing is the whole story; a missing workflow of that name is not
  const worth = problems.filter(
    (problem) => problem.message !== `package '${name}' has no usable workflow.yaml`,
  );
  if (worth.length === 0) {
    return `${name}: no workflow named '${name}' in ${dir}`;
  }
  const lines = worth.flatMap((problem) => [
    `  ${relative(dir, problem.filePath) || basename(problem.filePath)}: ${lower(problem.message)}`,
    ...problem.issues.map((issue) => `    ${issue}`),
  ]);
  return [
    `${name} can't run, ${worth.length === 1 ? 'a file is' : `${worth.length} files are`} invalid:`,
    ...lines,
    `  in ${dir}`,
  ].join('\n');
}

/** Messages read as sentence fragments under the file they belong to. */
function lower(message: string): string {
  return message.charAt(0).toLowerCase() + message.slice(1);
}
