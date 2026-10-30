import * as vscode from 'vscode';
import { BlockMark } from '../model/matcher';
import { Move } from '../model/refactor';
import { PlanState } from '../state';
import { relUnder } from './decorations';

/** The moves that would keep the objects a block creates: the block is where they moved to. */
export function movesInto(store: PlanState, mark: BlockMark): Move[] {
  if (!vscode.workspace.getConfiguration('planLens').get<boolean>('refactor', true)) return [];
  const found = new Map<string, Move>();
  for (const c of mark.changes) {
    if (c.action !== 'create') continue;
    const m = store.moveOf(c.address);
    if (m) found.set(m.id, m);
  }
  return [...found.values()];
}

/** End-of-line words for a block that looks moved here: `looks moved from terraform_data.lake`. */
export function movedHint(moves: Move[]): string {
  if (!moves.length) return '';
  return moves.length === 1 ? ` · looks moved from ${moves[0].from}` : ` · ${moves.length} look moved here`;
}

/** Quick fix on a block that looks moved here: add the moved block(s) to moved.tf. */
export function registerMoveActions(ctx: vscode.ExtensionContext, store: PlanState): void {
  const provider: vscode.CodeActionProvider = {
    provideCodeActions(doc, range) {
      if (!store.plan || !store.root || doc.uri.scheme !== 'file') return;
      const rel = relUnder(store.root, doc.uri.fsPath);
      if (!rel) return;
      const mark = store.marksFor(rel, doc.getText()).find((m) => range.start.line >= m.block.startLine && range.start.line <= m.block.endLine);
      if (!mark) return;
      const moves = movesInto(store, mark);
      const actions = moves.slice(0, 5).map((m) => {
        const a = new vscode.CodeAction(`Plan Lens: keep ${m.from} (add moved block, ${Math.floor(m.score * 100)}% match)`, vscode.CodeActionKind.QuickFix);
        a.command = { command: 'planLens.writeMoves', title: 'Add moved block', arguments: [[m.id], false] };
        a.isPreferred = moves.length === 1 && !m.ambiguous;
        return a;
      });
      if (moves.length > 1) {
        const all = new vscode.CodeAction(`Plan Lens: keep all ${moves.length} (add moved blocks, then re-plan)`, vscode.CodeActionKind.QuickFix);
        all.command = { command: 'planLens.writeMoves', title: 'Add moved blocks', arguments: [moves.map((m) => m.id), true] };
        actions.push(all);
      }
      return actions;
    },
  };
  ctx.subscriptions.push(
    vscode.languages.registerCodeActionsProvider([{ language: 'terraform' }, { scheme: 'file', pattern: '**/*.tf' }], provider, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }),
  );
}
