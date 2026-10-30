import * as vscode from 'vscode';
import { hoverMarkdown } from '../model/hoverMarkdown';
import { PlanState } from '../state';
import { relUnder } from './decorations';
import { movesInto } from './moves';

export function registerHover(ctx: vscode.ExtensionContext, store: PlanState): void {
  const provider: vscode.HoverProvider = {
    provideHover(doc, pos) {
      if (!store.plan || !store.root || doc.uri.scheme !== 'file') return;
      const rel = relUnder(store.root, doc.uri.fsPath, store.plan.moduleDirs);
      if (!rel) return;
      const mark = store.marksFor(rel, doc.getText()).find((m) => pos.line >= m.block.startLine && pos.line <= m.block.endLine);
      if (!mark) return;
      // Only on the header line or the gutter-adjacent first column, so it doesn't follow every attribute hover.
      if (pos.line !== mark.block.startLine) return;
      const md = new vscode.MarkdownString(hoverMarkdown(mark, store.plan.drift), true);
      // Refactor autopilot: a create that is really an object moved here.
      for (const m of movesInto(store, mark).slice(0, 5)) {
        const args = encodeURIComponent(JSON.stringify([[m.id], false]));
        md.appendMarkdown(`\n\n$(arrow-swap) Looks moved from \`${m.from}\` (${Math.floor(m.score * 100)}% match${m.ambiguous ? ', ambiguous' : ''}) · [Add moved block](command:planLens.writeMoves?${args})`);
      }
      md.supportHtml = true;
      md.isTrusted = { enabledCommands: ['planLens.reveal', 'planLens.copyAddress', 'planLens.openLog', 'planLens.writeMoves'] };
      return new vscode.Hover(md, doc.lineAt(mark.block.startLine).range);
    },
  };
  ctx.subscriptions.push(
    vscode.languages.registerHoverProvider([{ language: 'terraform' }, { scheme: 'file', pattern: '**/*.tf' }], provider),
  );
}
