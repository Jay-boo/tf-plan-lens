import * as vscode from 'vscode';
import { hoverMarkdown } from '../model/hoverMarkdown';
import { PlanState } from '../state';
import { relUnder } from './decorations';

export function registerHover(ctx: vscode.ExtensionContext, store: PlanState): void {
  const provider: vscode.HoverProvider = {
    provideHover(doc, pos) {
      if (!store.plan || !store.root || doc.uri.scheme !== 'file') return;
      const rel = relUnder(store.root, doc.uri.fsPath);
      if (!rel) return;
      const mark = store.marksFor(rel, doc.getText()).find((m) => pos.line >= m.block.startLine && pos.line <= m.block.endLine);
      if (!mark) return;
      // Only on the header line or the gutter-adjacent first column, so it doesn't follow every attribute hover.
      if (pos.line !== mark.block.startLine) return;
      const md = new vscode.MarkdownString(hoverMarkdown(mark), true);
      md.supportHtml = true;
      md.isTrusted = { enabledCommands: ['planLens.reveal', 'planLens.copyAddress', 'planLens.openLog'] };
      return new vscode.Hover(md, doc.lineAt(mark.block.startLine).range);
    },
  };
  ctx.subscriptions.push(
    vscode.languages.registerHoverProvider([{ language: 'terraform' }, { scheme: 'file', pattern: '**/*.tf' }], provider),
  );
}
