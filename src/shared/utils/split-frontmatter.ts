export interface FrontmatterSplit {
  readonly frontmatter: string;
  readonly body: string;
}

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

export function splitFrontmatter(source: string): FrontmatterSplit | null {
  const match = FRONTMATTER_PATTERN.exec(source);
  if (!match) {
    return null;
  }
  return {
    frontmatter: match[1] ?? '',
    body: source.slice(match[0].length),
  };
}
