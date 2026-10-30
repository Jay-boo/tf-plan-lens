import * as vscode from 'vscode';
import { BlockMark, relUnder } from '../model/matcher';
import { Action } from '../model/types';
import { PlanState } from '../state';
import { movedHint, movesInto } from './moves';

type Shown = Exclude<Action, 'noop'>;
/** forget shares destroy's look. */
const LOOK: Record<Shown, 'create' | 'update' | 'replace' | 'destroy' | 'read'> = {
  create: 'create', update: 'update', replace: 'replace', destroy: 'destroy', forget: 'destroy', read: 'read',
};
const LOOKS = ['create', 'update', 'replace', 'destroy', 'read'] as const;

export { relUnder };

export class Decorations implements vscode.Disposable {
  private readonly band = new Map<string, vscode.TextEditorDecorationType>();
  private readonly header = new Map<string, vscode.TextEditorDecorationType>();
  private readonly noop: vscode.TextEditorDecorationType;
  private readonly subs: vscode.Disposable[] = [];
  private timer: NodeJS.Timeout | undefined;

  constructor(ctx: vscode.ExtensionContext, private readonly store: PlanState) {
    for (const a of LOOKS) {
      this.band.set(a, vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        backgroundColor: new vscode.ThemeColor(`planLens.${a}Background`),
        borderWidth: '0 0 0 2px',
        borderStyle: 'solid',
        borderColor: new vscode.ThemeColor(`planLens.${a}`),
        overviewRulerColor: new vscode.ThemeColor(`planLens.${a}`),
        overviewRulerLane: vscode.OverviewRulerLane.Left,
      }));
      this.header.set(a, vscode.window.createTextEditorDecorationType({
        light: { gutterIconPath: vscode.Uri.joinPath(ctx.extensionUri, 'media', 'gutter', `${a}-light.svg`) },
        dark: { gutterIconPath: vscode.Uri.joinPath(ctx.extensionUri, 'media', 'gutter', `${a}-dark.svg`) },
        gutterIconSize: '80%',
        after: { color: new vscode.ThemeColor(`planLens.${a}`), fontStyle: 'italic', margin: '0 0 0 2em' },
      }));
    }
    this.noop = vscode.window.createTextEditorDecorationType({
      after: { color: new vscode.ThemeColor('editorCodeLens.foreground'), fontStyle: 'italic', margin: '0 0 0 2em' },
    });
    this.subs.push(
      vscode.window.onDidChangeVisibleTextEditors(() => this.refreshAll()),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (!e.document.fileName.endsWith('.tf')) return;
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.refreshAll(), 200);
      }),
      vscode.workspace.onDidChangeConfiguration((e) => ['showUnchanged', 'editorMarkers', 'refactor'].some((k) => e.affectsConfiguration(`planLens.${k}`)) && this.refreshAll()),
      store.onDidChange(() => this.refreshAll()),
    );
    this.refreshAll();
  }

  refreshAll(): void {
    for (const e of vscode.window.visibleTextEditors) this.refresh(e);
  }

  refresh(editor: vscode.TextEditor): void {
    const doc = editor.document;
    let marks: BlockMark[] = [];
    const markers = vscode.workspace.getConfiguration('planLens').get<boolean>('editorMarkers', true);
    if (markers && this.store.plan && this.store.root && doc.uri.scheme === 'file' && doc.fileName.endsWith('.tf')) {
      const rel = relUnder(this.store.root, doc.uri.fsPath, this.store.plan.moduleDirs);
      if (rel) marks = this.store.marksFor(rel, doc.getText());
    }
    const showNoop = vscode.workspace.getConfiguration('planLens').get<boolean>('showUnchanged', true);
    const bands = new Map<string, vscode.Range[]>(LOOKS.map((a) => [a, []]));
    const headers = new Map<string, vscode.DecorationOptions[]>(LOOKS.map((a) => [a, []]));
    const noops: vscode.DecorationOptions[] = [];
    const previewed = this.store.previewed.get(doc.uri.toString());
    for (const m of marks) {
      // An edit preview of this block is newer than the plan: its hint speaks instead.
      if (previewed?.has(m.block.startLine)) continue;
      const line = doc.lineAt(Math.min(m.block.startLine, doc.lineCount - 1));
      const opt: vscode.DecorationOptions = { range: line.range, renderOptions: { after: { contentText: hintText(m) + movedHint(movesInto(this.store, m)) } } };
      if (m.action === 'noop') {
        if (showNoop) noops.push(opt);
        continue;
      }
      const look = LOOK[m.action];
      bands.get(look)!.push(new vscode.Range(m.block.startLine, 0, Math.min(m.block.endLine, doc.lineCount - 1), 0));
      headers.get(look)!.push(opt);
    }
    for (const a of LOOKS) {
      editor.setDecorations(this.band.get(a)!, bands.get(a)!);
      editor.setDecorations(this.header.get(a)!, headers.get(a)!);
    }
    editor.setDecorations(this.noop, noops);
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.subs.forEach((s) => s.dispose());
    [...this.band.values(), ...this.header.values(), this.noop].forEach((d) => d.dispose());
  }
}

const GLYPH: Record<Action, string> = { create: '+', update: '~', replace: '⟳', destroy: '−', forget: '−', read: '◉', noop: '' };

function hintText(m: BlockMark): string {
  return GLYPH[m.action] ? `${GLYPH[m.action]} ${m.hint}` : m.hint;
}
