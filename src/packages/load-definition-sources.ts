import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  DefinitionOrigin,
  DefinitionSource,
  PackagePath,
} from '../definitions/definition-set';

const AGENT_EXTENSIONS = ['.md'];
const PACKAGE_MANIFESTS = ['workflow.yaml', 'workflow.yml'];
const SCRIPT_MANIFESTS = ['script.yaml', 'script.yml'];

type Origin = Exclude<DefinitionOrigin, 'built-in'>;

/**
 * Reads one `.taliqraph` root into raw definition sources: every package
 * `workflows/<name>/` (its `workflow.yaml`, `agents/`, `scripts/`,
 * `standards/`, `skills/` and nested `workflows/`), the loose pieces beside
 * them (`agents/`, `scripts/`, `standards/`, `skills/` at the root). Missing
 * directories are simply empty; unreadable files are skipped (a vanished file mid-watch is not an
 * error).
 */
export async function loadDefinitionSources(
  rootDir: string,
  origin: Origin,
): Promise<DefinitionSource[]> {
  const [agents, standards, skills, scripts, packages] = await Promise.all([
    readSources(join(rootDir, 'agents'), 'agent', origin, AGENT_EXTENSIONS),
    readSources(join(rootDir, 'standards'), 'standard', origin, AGENT_EXTENSIONS),
    readSkillSources(join(rootDir, 'skills'), origin),
    readScriptSources(join(rootDir, 'scripts'), origin),
    readPackages(join(rootDir, 'workflows'), origin, []),
  ]);
  return [...agents, ...standards, ...skills, ...scripts, ...packages];
}

/** Every `<dir>/<name>/workflow.yaml` package, recursively into its own `workflows/`. */
async function readPackages(
  dir: string,
  origin: Origin,
  parent: PackagePath,
): Promise<DefinitionSource[]> {
  const sources: DefinitionSource[] = [];
  for (const folder of await names(dir, true)) {
    sources.push(...(await readPackage(join(dir, folder), origin, [...parent, folder])));
  }
  return sources;
}

/** One package folder (its manifest, members and nested packages) as sources - also used to mount a package from anywhere. */
export async function readPackage(
  dir: string,
  origin: Origin,
  packagePath: PackagePath,
): Promise<DefinitionSource[]> {
  let manifest: DefinitionSource | null = null;
  for (const name of PACKAGE_MANIFESTS) {
    const filePath = join(dir, name);
    try {
      manifest = {
        kind: 'workflow',
        origin,
        filePath,
        content: await readFile(filePath, 'utf8'),
        packagePath,
      };
      break;
    } catch {
      // try the other spelling
    }
  }
  if (!manifest) {
    return []; // a folder under workflows/ without a manifest is not a package
  }
  const [agents, standards, skills, scripts, nested] = await Promise.all([
    readSources(join(dir, 'agents'), 'agent', origin, AGENT_EXTENSIONS, packagePath),
    readSources(join(dir, 'standards'), 'standard', origin, AGENT_EXTENSIONS, packagePath),
    readSkillSources(join(dir, 'skills'), origin, packagePath),
    readScriptSources(join(dir, 'scripts'), origin, packagePath),
    readPackages(join(dir, 'workflows'), origin, packagePath),
  ]);
  return [manifest, ...agents, ...standards, ...skills, ...scripts, ...nested];
}

/** Scripts are folders: `scripts/<name>/script.yaml` next to the code it runs. */
async function readScriptSources(
  dir: string,
  origin: Origin,
  packagePath?: PackagePath,
): Promise<DefinitionSource[]> {
  const sources: DefinitionSource[] = [];
  for (const folder of await names(dir, true)) {
    for (const manifest of SCRIPT_MANIFESTS) {
      const filePath = join(dir, folder, manifest);
      try {
        sources.push({
          kind: 'script',
          origin,
          filePath,
          content: await readFile(filePath, 'utf8'),
          ...(packagePath ? { packagePath } : {}),
        });
        break;
      } catch {
        // no manifest under that name - try the other spelling, else it's just a folder
      }
    }
  }
  return sources;
}

async function readSources(
  dir: string,
  kind: DefinitionSource['kind'],
  origin: Origin,
  extensions: readonly string[],
  packagePath?: PackagePath,
): Promise<DefinitionSource[]> {
  const sources: DefinitionSource[] = [];
  for (const name of await names(dir)) {
    if (!extensions.some((extension) => name.endsWith(extension))) {
      continue;
    }
    const filePath = join(dir, name);
    try {
      sources.push({
        kind,
        origin,
        filePath,
        content: await readFile(filePath, 'utf8'),
        ...(packagePath ? { packagePath } : {}),
      });
    } catch {
      // vanished between readdir and read - the next watch tick reloads
    }
  }
  return sources;
}

/**
 * Skills load flat (`skills/foo.md`) AND in the ecosystem layout
 * (`skills/foo/SKILL.md`) so a copy of ~/.claude/skills just works.
 */
async function readSkillSources(
  dir: string,
  origin: Origin,
  packagePath?: PackagePath,
): Promise<DefinitionSource[]> {
  let entries: string[];
  try {
    entries = await readdir(dir, { withFileTypes: true }).then((found) =>
      found.map((entry) => (entry.isDirectory() ? `${entry.name}/SKILL.md` : entry.name)),
    );
  } catch {
    return [];
  }
  const sources: DefinitionSource[] = [];
  for (const name of entries.sort()) {
    if (!name.endsWith('.md')) {
      continue;
    }
    const filePath = join(dir, name);
    try {
      sources.push({
        kind: 'skill',
        origin,
        filePath,
        content: await readFile(filePath, 'utf8'),
        ...(packagePath ? { packagePath } : {}),
      });
    } catch {
      // a bare directory without SKILL.md, or vanished mid-watch - skip
    }
  }
  return sources;
}

/** The sorted entry names of a directory (folders only on request); an absent directory is empty. */
async function names(dir: string, directoriesOnly = false): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => (directoriesOnly ? entry.isDirectory() : true))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}
