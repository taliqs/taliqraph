import { describe, expect, it } from 'vitest';
import { splitFrontmatter } from './split-frontmatter';

describe('splitFrontmatter', () => {
  it('splits frontmatter from body', () => {
    const source = '---\nname: engineer\n---\nYou implement changes.';
    expect(splitFrontmatter(source)).toEqual({
      frontmatter: 'name: engineer',
      body: 'You implement changes.',
    });
  });

  it('handles CRLF line endings', () => {
    const source = '---\r\nname: engineer\r\n---\r\nBody text.';
    expect(splitFrontmatter(source)).toEqual({
      frontmatter: 'name: engineer',
      body: 'Body text.',
    });
  });

  it('handles a document that is only frontmatter', () => {
    const source = '---\nname: engineer\n---';
    expect(splitFrontmatter(source)).toEqual({ frontmatter: 'name: engineer', body: '' });
  });

  it('returns null when there is no frontmatter', () => {
    expect(splitFrontmatter('Just a prompt body.')).toBeNull();
  });

  it('returns null when frontmatter does not start on the first line', () => {
    expect(splitFrontmatter('\n---\nname: x\n---\nbody')).toBeNull();
  });
});
