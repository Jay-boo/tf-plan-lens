// Text for the Plan Lens log terminal. Pure: nothing here may import 'vscode'.

/** A terminal moves down on \n but only goes back to the start of the line on \r. */
export function crlf(s: string): string {
  return s.replace(/\r?\n/g, '\r\n');
}

/** The log's tail, replayed when the terminal is (re)opened; capped so a long session can't grow without end. */
export class LogBuffer {
  private buf = '';

  constructor(private readonly max = 1_000_000) {}

  push(s: string): void {
    this.buf += s;
    if (this.buf.length <= this.max) return;
    const tail = this.buf.slice(this.buf.length - this.max);
    // Start on a whole line, so no colour code or line is cut in half (unless one line is the whole tail).
    const nl = tail.indexOf('\n');
    this.buf = nl >= 0 && nl < tail.length - 1 ? tail.slice(nl + 1) : tail;
  }

  text(): string {
    return this.buf;
  }
}

/** The last n non-blank lines of a run as plain text: colours dropped, a line rewritten with \r shown as it ends. */
export function tailLines(s: string, n: number): string[] {
  const lines = s
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .split(/\r?\n/)
    .map((l) => l.slice(l.lastIndexOf('\r') + 1).trimEnd())
    .filter((l) => l.trim());
  return lines.slice(-n);
}
