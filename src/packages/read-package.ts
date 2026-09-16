import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import type { PackageBundleFile } from '../bundles/tqh';
import { parsePackageTqh } from '../bundles/tqh';
import { parseWorkflowDefinition } from '../definitions/workflow/parse-workflow-definition';

const PACKAGE_MANIFESTS = ['workflow.yaml', 'workflow.yml'];

/** Every text file under a package folder, relative with forward slashes. */
export async function readPackageFiles(dir: string): Promise<PackageBundleFile[]> {
  const files: PackageBundleFile[] = [];
  const walk = async (current: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.')) {
        continue;
      }
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else {
        files.push({
          path: relative(dir, full).split(/[\\/]/).join('/'),
          content: await readFile(full, 'utf8'),
        });
      }
    }
  };
  await walk(dir);
  return files;
}

/** A package folder (its manifest names it) or a bundle file, as the files it holds; null when it is neither. */
export async function readBundleSource(
  source: string,
): Promise<{ name: string; files: readonly PackageBundleFile[] } | null> {
  const path = resolve(source);
  for (const manifest of PACKAGE_MANIFESTS) {
    if (existsSync(join(path, manifest))) {
      const files = await readPackageFiles(path);
      const workflow = files.find((file) => file.path === manifest);
      const parsed = workflow ? parseWorkflowDefinition(workflow.content, 'global') : null;
      const name = parsed?.ok ? parsed.value.name : basename(path);
      return { name, files };
    }
  }
  try {
    const bundle = parsePackageTqh(await readFile(path, 'utf8'));
    return bundle ? { name: bundle.name, files: bundle.files } : null;
  } catch {
    return null;
  }
}
