import { Document, isMap, isScalar, Scalar, YAMLMap, parseDocument } from 'yaml';
import { z } from 'zod';

/** The single-file form of a workflow package, and the `format` marker at its top. */
export const TQH_EXTENSION = '.tqh';
export const TQH_FORMAT = 'taliqraph-package';

/**
 * A workflow package travels between machines as one YAML file: a short head,
 * then every file of the folder as a block literal, so the file reads like the
 * folder itself and diffs line by line. Credential-free by construction:
 * definition files never hold secrets, and the lint refuses anything
 * token-shaped.
 */

export interface PackageBundleFile {
  /** Relative to the package folder, forward slashes: `workflow.yaml`, `agents/x.agent.md`, … */
  readonly path: string;
  readonly content: string;
}

export interface PackageBundle {
  readonly format: typeof TQH_FORMAT;
  readonly version: 1;
  readonly createdAt: string;
  readonly name: string;
  readonly files: readonly PackageBundleFile[];
}

const packageBundleSchema = z.object({
  format: z.literal(TQH_FORMAT),
  version: z.literal(1),
  createdAt: z.string(),
  name: z.string().regex(/^[a-z][a-z0-9-]*$/),
  files: z.array(z.object({ path: z.string().min(1), content: z.string() })),
});

export function buildPackageTqh(
  name: string,
  files: readonly PackageBundleFile[],
  now: () => string = () => new Date().toISOString(),
): string {
  const doc = new Document({ format: TQH_FORMAT, version: 1, name, created: now() });
  const fileMap = new YAMLMap<Scalar<string>, Scalar<string>>(doc.schema);
  for (const file of files) {
    // the literal style keeps every byte, the chomping indicator the trailing newlines
    const content = new Scalar(file.content);
    content.type = Scalar.BLOCK_LITERAL;
    fileMap.add(doc.createPair(new Scalar(file.path), content));
  }
  doc.set('files', fileMap);
  return doc.toString({ lineWidth: 0 });
}

export function parsePackageTqh(text: string): PackageBundle | null {
  const doc = parseDocument(text, { uniqueKeys: true });
  const root = doc.contents;
  if (doc.errors.length > 0 || !isMap(root)) {
    return null;
  }
  const fileMap = root.get('files', true);
  const files = isMap(fileMap)
    ? fileMap.items.map((pair) => ({
        path: isScalar(pair.key) ? pair.key.value : undefined,
        content: isScalar(pair.value) ? pair.value.value : undefined,
      }))
    : undefined;
  const result = packageBundleSchema.safeParse({
    format: root.get('format'),
    version: root.get('version'),
    createdAt: root.get('created'),
    name: root.get('name'),
    files,
  });
  if (!result.success) {
    return null;
  }
  // no path may climb out of the package folder
  if (
    result.data.files.some((file) =>
      file.path.split('/').some((part) => part === '..' || part === ''),
    )
  ) {
    return null;
  }
  return result.data;
}

export interface SecretFinding {
  readonly name: string;
  readonly kind: string;
  readonly match: string;
}

const SECRET_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: 'GitHub token', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { label: 'GitHub PAT', pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { label: 'OpenAI/Anthropic key', pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { label: 'Slack token', pattern: /\bxox[a-z]-[A-Za-z0-9-]{10,}\b/ },
  { label: 'AWS access key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: 'Bearer token', pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{24,}=*/ },
  { label: 'Private key block', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { label: 'Atlassian token', pattern: /\bATATT[A-Za-z0-9_-]{20,}\b/ },
];

export interface SecretLintItem {
  readonly name: string;
  readonly source: string;
}

export function lintBundleSecrets(items: readonly SecretLintItem[]): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const item of items) {
    for (const { label, pattern } of SECRET_PATTERNS) {
      const match = pattern.exec(item.source);
      if (match) {
        findings.push({
          name: item.name,
          kind: label,
          match: `${match[0].slice(0, 12)}…`,
        });
      }
    }
  }
  return findings;
}
