import { appendFileSync } from 'node:fs';
import * as vscode from 'vscode';
import { LogBuffer, crlf, tailLines } from './model/logText';

const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

/**
 * The Plan Lens log: a read-only terminal, so terraform's own colours show (the Output panel prints the raw codes).
 * Kept in memory and replayed when the terminal is opened again after being closed.
 */
export class PlanLog implements vscode.Disposable {
  private readonly buffer = new LogBuffer();
  private terminal?: vscode.Terminal;
  private writer?: vscode.EventEmitter<string>;
  private open = false;
  /** The current run's output (since its heading), for the sidebar's live tail. */
  private run = '';
  private readonly appended = new vscode.EventEmitter<void>();
  readonly onDidAppend = this.appended.event;
  private readonly sub = vscode.window.onDidCloseTerminal((t) => t === this.terminal && this.drop());

  append(s: string): void {
    // Tests read what terraform said from a file (PLAN_LENS_LOG_FILE is only set by test/e2e).
    if (process.env.PLAN_LENS_LOG_FILE) appendFileSync(process.env.PLAN_LENS_LOG_FILE, s);
    const t = crlf(s);
    this.buffer.push(t);
    if (this.open) this.writer!.fire(t);
    this.run = (this.run + t).slice(-20_000);
    this.appended.fire();
  }

  /** The current run's last lines, plain text. */
  tail(n = 6): string[] {
    return tailLines(this.run, n);
  }

  appendLine(s: string): void {
    this.append(`${s}\n`);
  }

  /** `── Plan DEV · 2:30 PM ──` */
  heading(s: string): void {
    this.run = '';
    this.appendLine(`${BOLD}${s}${RESET}`);
  }

  /** `$ terraform plan …` */
  command(s: string): void {
    this.appendLine(`${DIM}$ ${s}${RESET}`);
  }

  show(preserveFocus = true): void {
    if (!this.terminal) {
      const writer = new vscode.EventEmitter<string>();
      this.writer = writer;
      this.terminal = vscode.window.createTerminal({
        name: 'Plan Lens',
        iconPath: new vscode.ThemeIcon('checklist'),
        isTransient: true,
        pty: {
          onDidWrite: writer.event,
          open: () => {
            this.open = true;
            writer.fire(this.buffer.text());
          },
          close: () => this.drop(),
        },
      });
    }
    this.terminal.show(preserveFocus);
  }

  private drop(): void {
    this.open = false;
    this.terminal = undefined;
    this.writer?.dispose();
    this.writer = undefined;
  }

  dispose(): void {
    this.sub.dispose();
    this.appended.dispose();
    this.terminal?.dispose();
    this.drop();
  }
}
