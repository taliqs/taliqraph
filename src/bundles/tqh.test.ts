import { describe, expect, it } from 'vitest';
import { buildPackageTqh, lintBundleSecrets, parsePackageTqh } from './tqh';

const files = [
  { path: 'workflow.yaml', content: 'name: question\nsteps: []\n' },
  {
    path: 'agents/investigator.agent.md',
    content: '---\nname: investigator\n---\nYou investigate.\n',
  },
];

describe('package bundles', () => {
  it('writes a readable YAML file with every file as a block literal', () => {
    const text = buildPackageTqh('question', files, () => '2026-09-02T12:00:00.000Z');
    expect(text).toBe(
      [
        'format: taliqraph-package',
        'version: 1',
        'name: question',
        'created: 2026-09-02T12:00:00.000Z',
        'files:',
        '  workflow.yaml: |',
        '    name: question',
        '    steps: []',
        '  agents/investigator.agent.md: |',
        '    ---',
        '    name: investigator',
        '    ---',
        '    You investigate.',
        '',
      ].join('\n'),
    );
  });

  it('round-trips through build and parse', () => {
    const text = buildPackageTqh('question', files, () => '2026-09-02T12:00:00.000Z');
    const bundle = parsePackageTqh(text);
    expect(bundle).toEqual({
      format: 'taliqraph-package',
      version: 1,
      createdAt: '2026-09-02T12:00:00.000Z',
      name: 'question',
      files,
    });
  });

  it('keeps every byte: no final newline, several final newlines, blank lines, tabs, CRLF', () => {
    const awkward = [
      { path: 'no-newline.md', content: 'ends without a newline' },
      { path: 'many-newlines.md', content: 'ends with three\n\n\n' },
      { path: 'blank-lines.yaml', content: 'a: 1\n\n\nb: 2\n' },
      { path: 'indented.txt', content: '  starts indented\n\ttab\n' },
      { path: 'crlf.txt', content: 'line one\r\nline two\r\n' },
      { path: 'empty.txt', content: '' },
      { path: 'spaces.txt', content: 'trailing spaces   \nlast line with trailing spaces  ' },
      { path: 'nested/deep/file.json', content: '{"key": "value"}\n' },
    ];
    const text = buildPackageTqh('awkward', awkward, () => 'x');
    expect(parsePackageTqh(text)?.files).toEqual(awkward);
    // and the common cases read as block literals with the matching chomping
    expect(text).toContain('  no-newline.md: |-\n    ends without a newline\n');
    expect(text).toContain('  many-newlines.md: |+\n    ends with three\n\n\n');
  });

  it('rejects garbage, wrong formats, missing fields and paths that climb out', () => {
    expect(parsePackageTqh('not: [valid')).toBeNull();
    expect(parsePackageTqh('just a string')).toBeNull();
    expect(parsePackageTqh('format: zip\nversion: 1\nname: q\ncreated: x\nfiles: {}\n')).toBeNull();
    expect(
      parsePackageTqh('format: taliqraph-package\nversion: 2\nname: q\ncreated: x\nfiles: {}\n'),
    ).toBeNull();
    expect(
      parsePackageTqh('format: taliqraph-package\nversion: 1\nname: q\ncreated: x\nfiles: []\n'),
    ).toBeNull();
    expect(
      parsePackageTqh(
        'format: taliqraph-package\nversion: 1\nname: q\ncreated: x\nfiles:\n  a.md: [1]\n',
      ),
    ).toBeNull();
    expect(
      parsePackageTqh(buildPackageTqh('q', [{ path: '../escape.yaml', content: '' }], () => 'x')),
    ).toBeNull();
    expect(
      parsePackageTqh(buildPackageTqh('q', [{ path: 'agents//x.md', content: '' }], () => 'x')),
    ).toBeNull();
  });

  it('flags token-shaped content per file', () => {
    const findings = lintBundleSecrets([
      { name: 'leaky', source: 'token: ghp_abcdefghijklmnopqrstuv123456' },
      { name: 'clean', source: 'Branch names follow feature/PW-123.' },
      { name: 'keyish', source: 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpX' },
    ]);
    expect(findings.map((finding) => finding.name)).toEqual(['leaky', 'keyish']);
    expect(findings[0]?.kind).toBe('GitHub token');
    expect(findings[0]?.match).toContain('…'); // never the full token
  });

  it('does not false-positive on ordinary prose and code', () => {
    expect(
      lintBundleSecrets([
        { name: 'ok', source: 'Use git push -u origin branch. Skip node_modules.' },
      ]),
    ).toEqual([]);
  });
});
