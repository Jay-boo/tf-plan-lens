import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { Block, scanBlocks } from '../model/hclScanner';
import { hoverMarkdown } from '../model/hoverMarkdown';
import { BlockMark, hintFor } from '../model/matcher';
import { parsePlan } from '../model/planParser';
import { PreviewHint, blockTargets, callsOf, changedBlocks, previewHints } from '../model/preview';
import { worst } from '../model/types';
import { RunError, Runner } from '../runner';
import { PlanStore } from '../state';
import { relUnder } from './decorations';

const LOOKS: PreviewHint['look'][] = ['create', 'update', 'replace', 'destroy', 'read', 'noop'];

interface Shown {
  version: number;
  hints: PreviewHint[];
  /** For the hover: each previewed block with what the preview plans for it. */
  marks: BlockMark[];
}

/**
 * Edit preview: on save, plans only the blocks edited since the last full plan (no refresh, no lock) and says on the
 * edited lines what that would do — before anyone runs a real plan.
 */
export class EditPreview implements vscode.Disposable {
  private readonly deco = new Map<string, vscode.TextEditorDecorationType>();
  /** File text as of the last full plan (or when first seen after it): what edits are measured against. */
  private readonly baseline = new Map<string, string>();
  private readonly shown = new Map<string, Shown>();
  private readonly subs: vscode.Disposable[] = [];
  private running?: vscode.CancellationTokenSource;
  private planAt = 0;

  constructor(private readonly store: PlanStore, private readonly runner: Runner) {
    for (const look of LOOKS) {
      const color = new vscode.ThemeColor(look === 'noop' ? 'planLens.create' : `planLens.${look}`);
      this.deco.set(look, vscode.window.createTextEditorDecorationType({
        after: { color, margin: '0 0 0 2em', fontWeight: '600', border: '1px solid', borderColor: color, textDecoration: 'none; border-radius: 4px; padding: 0 5px; opacity: 0.9' },
      }));
    }
    this.subs.push(
      vscode.workspace.onDidOpenTextDocument((d) => void this.remember(d)),
      vscode.workspace.onDidSaveTextDocument((d) => void this.preview(d)),
      // Typing makes a preview stale: it goes until the next save.
      vscode.workspace.onDidChangeTextDocument((e) => {
        const s = this.shown.get(e.document.uri.toString());
        if (s && e.contentChanges.length && this.touches(s, e.contentChanges)) {
          this.shown.delete(e.document.uri.toString());
          this.paint();
        }
      }),
      vscode.window.onDidChangeVisibleTextEditors(() => this.paint()),
      vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('planLens.preview') && (this.shown.clear(), this.paint())),
      store.onDidChange(() => {
        // A new full plan: it shows the truth, previews are spent and edits are measured from now.
        const at = store.plan?.loadedAt ?? 0;
        if (at !== this.planAt) {
          this.planAt = at;
          this.shown.clear();
          this.baseline.clear();
          for (const d of vscode.workspace.textDocuments) void this.remember(d);
          this.paint();
        }
      }),
      vscode.languages.registerHoverProvider([{ language: 'terraform' }, { scheme: 'file', pattern: '**/*.tf' }], { provideHover: (doc, pos) => this.hover(doc, pos) }),
    );
    for (const d of vscode.workspace.textDocuments) void this.remember(d);
  }

  private touches(s: Shown, changes: readonly vscode.TextDocumentContentChangeEvent[]): boolean {
    return changes.some((c) => s.marks.some((m) => c.range.start.line <= m.block.endLine && c.range.end.line >= m.block.startLine)) || changes.some((c) => c.text.includes('\n') || c.range.start.line !== c.range.end.line);
  }

  /** Records a .tf file's text on disk as its baseline, unless it already has one. */
  private async remember(d: vscode.TextDocument): Promise<void> {
    if (d.uri.scheme !== 'file' || !d.fileName.endsWith('.tf') || this.baseline.has(d.uri.fsPath)) return;
    this.baseline.set(d.uri.fsPath, d.isDirty ? await readFile(d.uri.fsPath, 'utf8').catch(() => '') : d.getText());
  }

  private async preview(doc: vscode.TextDocument): Promise<void> {
    const env = this.store.env;
    const plan = this.store.plan;
    const root = this.store.root;
    if (!vscode.workspace.getConfiguration('planLens').get<boolean>('preview', true) || !vscode.workspace.isTrusted) return;
    if (!env || !plan || !plan.env || plan.env !== env.name || !root || root !== env.root || this.store.running) return;
    const rel = relUnder(root, doc.uri.fsPath);
    if (!rel || !doc.fileName.endsWith('.tf')) return;
    const before = this.baseline.get(doc.uri.fsPath);
    if (before === undefined) return void this.remember(doc);
    const text = doc.getText();
    const blocks = changedBlocks(before, text).filter((b) => b.kind !== 'data');
    const key = doc.uri.toString();
    if (!blocks.length) {
      this.shown.delete(key);
      return this.paint();
    }
    const dir = path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel);
    const calls = callsOf(dir, plan.moduleDirs);
    const byBlock = new Map<Block, string[]>(blocks.map((b) => [b, blockTargets(b, calls)]));
    const targets = [...byBlock.values()].flat();
    if (!targets.length) return;
    this.running?.cancel();
    const cts = new vscode.CancellationTokenSource();
    this.running = cts;
    try {
      const json = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `Plan Lens: previewing ${targets.length} edited block${targets.length > 1 ? 's' : ''}…` },
        () => this.runner.preview(env, targets, cts.token));
      if (json === undefined || cts.token.isCancellationRequested || doc.version !== vscode.workspace.textDocuments.find((d) => d.uri.toString() === key)?.version) return;
      const p = parsePlan(json, { env: env.name, source: 'preview', loadedAt: Date.now() });
      const hints: PreviewHint[] = [];
      const marks: BlockMark[] = [];
      for (const [b, addrs] of byBlock) {
        // The block's own instances: `addr`, `addr[...]`; dependencies -target pulled in are not this block's news.
        const own = p.changes.filter((c) => addrs.some((a) => c.address === a || c.address.startsWith(`${a}[`) || (b.kind === 'module' && c.address.startsWith(`${a}.`))));
        hints.push(...previewHints(text, b, own));
        if (own.length) {
          const mark: BlockMark = { block: b, changes: own, action: worst(own.map((c) => c.action)), hint: '' };
          mark.hint = hintFor(mark);
          marks.push(mark);
        }
      }
      this.shown.set(key, { version: doc.version, hints, marks });
    } catch (e) {
      const err = e as RunError;
      if (err.cancelled) return;
      const msg = (err.message || String(e)).replace(/^Error: /, '');
      this.shown.set(key, { version: doc.version, hints: blocks.map((b) => ({ line: b.startLine, text: `◆ preview failed: ${msg.slice(0, 90)}`, look: 'destroy' as const })), marks: [] });
    } finally {
      if (this.running === cts) this.running = undefined;
      cts.dispose();
    }
    this.paint();
  }

  private paint(): void {
    for (const e of vscode.window.visibleTextEditors) {
      const s = this.shown.get(e.document.uri.toString());
      for (const look of LOOKS) {
        const opts = (s?.hints ?? []).filter((h) => h.look === look && h.line < e.document.lineCount)
          .map((h) => ({ range: e.document.lineAt(h.line).range, renderOptions: { after: { contentText: h.text } } }));
        e.setDecorations(this.deco.get(look)!, opts);
      }
    }
  }

  private hover(doc: vscode.TextDocument, pos: vscode.Position): vscode.Hover | undefined {
    const s = this.shown.get(doc.uri.toString());
    const mark = s?.marks.find((m) => pos.line >= m.block.startLine && pos.line <= m.block.endLine);
    if (!s || !mark || !s.hints.some((h) => h.line === pos.line)) return undefined;
    const md = new vscode.MarkdownString(`$(eye) **Preview of your edit** · ${this.store.env?.name ?? ''} · *quick plan of this block: no refresh, no lock, nothing to apply*\n\n`, true);
    md.appendMarkdown(hoverMarkdown(mark).split('\n---')[0]);
    md.supportHtml = true;
    return new vscode.Hover(md, doc.lineAt(pos.line).range);
  }

  dispose(): void {
    this.running?.cancel();
    this.subs.forEach((s) => s.dispose());
    this.deco.forEach((d) => d.dispose());
  }
}
