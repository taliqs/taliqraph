export interface OutputOptions {
  readonly json: boolean;
  readonly quiet: boolean;
  readonly color: boolean;
}

/** Where the text lands: stdout/stderr by default, a buffer in tests. */
export interface OutputSink {
  out(text: string): void;
  err(text: string): void;
}

export const STDIO_SINK: OutputSink = {
  out: (text) => {
    process.stdout.write(text);
  },
  err: (text) => {
    process.stderr.write(text);
  },
};

const ESC = String.fromCharCode(27);
const ANSI = {
  reset: `${ESC}[0m`,
  dim: `${ESC}[2m`,
  bold: `${ESC}[1m`,
  red: `${ESC}[31m`,
  green: `${ESC}[32m`,
  yellow: `${ESC}[33m`,
};
const NL = String.fromCharCode(10);

/** Where command output goes and how: plain lines, or JSON when asked; info lines vanish under -q. */
export class Output {
  constructor(
    readonly options: OutputOptions,
    private readonly sink: OutputSink = STDIO_SINK,
  ) {}

  /** A result line - always printed. */
  line(text = ''): void {
    this.sink.out(text + NL);
  }

  /** Progress and context - silenced by -q. */
  info(text: string): void {
    if (!this.options.quiet) {
      this.sink.out(text + NL);
    }
  }

  error(text: string): void {
    this.sink.err(this.paint('red', text) + NL);
  }

  /** Structured result: JSON under --json, otherwise the rendered text. */
  result(value: unknown, render: () => string | readonly string[]): void {
    if (this.options.json) {
      this.line(JSON.stringify(value, null, 2));
      return;
    }
    const rendered = render();
    this.line(typeof rendered === 'string' ? rendered : rendered.join(NL));
  }

  /** One NDJSON record - stream-json mode. */
  record(value: unknown): void {
    this.sink.out(JSON.stringify(value) + NL);
  }

  dim(text: string): string {
    return this.paint('dim', text);
  }

  bold(text: string): string {
    return this.paint('bold', text);
  }

  ok(text: string): string {
    return this.paint('green', text);
  }

  warn(text: string): string {
    return this.paint('yellow', text);
  }

  bad(text: string): string {
    return this.paint('red', text);
  }

  private paint(style: keyof typeof ANSI, text: string): string {
    return this.options.color ? `${ANSI[style]}${text}${ANSI.reset}` : text;
  }
}

/** Fixed-width columns for list output; the last column takes what is left. */
export function table(rows: ReadonlyArray<readonly string[]>): string[] {
  const widths = rows.reduce<number[]>(
    (acc, row) => row.map((cell, i) => Math.max(acc[i] ?? 0, cell.length)),
    [],
  );
  return rows.map((row) =>
    row
      .map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i] ?? cell.length)))
      .join('  ')
      .trimEnd(),
  );
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes}m` : `${minutes}m${String(rest).padStart(2, '0')}s`;
}

export function formatCost(usd: number | undefined): string {
  return usd === undefined ? '' : `$${usd.toFixed(2)}`;
}
