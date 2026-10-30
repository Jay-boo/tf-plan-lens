import * as path from 'node:path';
import * as vscode from 'vscode';
import { Evaluator } from '../evaluator';
import { EvalValue, inlineValue, instancesValue, prettyValue } from '../model/evalBatch';
import { IDENT, completionSpot, eachValues, keysOf, walk } from '../model/complete';
import { EvalTarget, evalTargets } from '../model/evalTargets';
import { scanBlocks } from '../model/hclScanner';
import { PlanStore } from '../state';

interface Shown {
  target: EvalTarget;
  value: EvalValue;
}

/** What the end of a line says for a value. */
export function valueText(t: EvalTarget, v: EvalValue): string {
  switch (v.kind) {
    case 'unknown': return '= (known after apply)';
    case 'sensitive': return '= (sensitive)';
    case 'error': return `⚠ ${v.message.replace(/^Error: /, '').slice(0, 80)}`;
    default: return t.kind === 'instances' ? `→ ${instancesValue(v.value)}` : `= ${inlineValue(v.value)}`;
  }
}

/**
 * Inline values: what locals, variables, for_each / count and outputs of the env's root module evaluate to, at the end
 * of their line and in a hover, computed by terraform console on Plan Lens's own copy of the configuration.
 */
export class InlineValues implements vscode.Disposable {
  private readonly deco = vscode.window.createTextEditorDecorationType({
    after: { color: new vscode.ThemeColor('editorInlayHint.foreground'), margin: '0 0 0 2.5em', fontStyle: 'normal' },
  });
  private readonly errDeco = vscode.window.createTextEditorDecorationType({
    after: { color: new vscode.ThemeColor('editorWarning.foreground'), margin: '0 0 0 2.5em', fontStyle: 'italic' },
  });
  /** By document: its version when evaluated, and the values by line. */
  private readonly shown = new Map<string, { version: number; env: string; byLine: Map<number, Shown> }>();
  /** Evaluate selection's last result, shown by the hover at that spot. */
  private picked?: { uri: string; range: vscode.Range; expr: string; value: EvalValue };
  private readonly subs: vscode.Disposable[] = [];
  private timer?: NodeJS.Timeout;
  private busy = false;
  private again = false;
  private envKey = '';
  private lastFailure = '';
  /** Values evaluated for completions, by env and expression, with the edits they were made with. */
  private readonly asked = new Map<string, { edits: string; value: EvalValue }>();

  constructor(private readonly store: PlanStore, private readonly evaluator: Evaluator, private readonly log: (s: string) => void) {
    const soon = (ms = 700) => {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => void this.refresh(), ms);
    };
    this.subs.push(
      vscode.window.onDidChangeVisibleTextEditors(() => soon(100)),
      vscode.workspace.onDidChangeTextDocument((e) => e.document.fileName.endsWith('.tf') && soon()),
      vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('planLens.inlineValues') && soon(0)),
      store.onDidChange(() => {
        // Only a new env (or root) changes values; the store also fires for every plan and clock tick.
        const key = `${store.env?.name}|${store.env?.root}`;
        if (key !== this.envKey) {
          this.envKey = key;
          this.shown.clear();
          soon(0);
        }
      }),
      vscode.languages.registerHoverProvider([{ language: 'terraform' }, { scheme: 'file', pattern: '**/*.tf' }], { provideHover: (doc, pos) => this.hover(doc, pos) }),
      vscode.commands.registerCommand('planLens.evaluateSelection', () => this.evaluateSelection()),
      vscode.languages.registerCompletionItemProvider([{ language: 'terraform' }, { scheme: 'file', pattern: '**/*.tf' }], { provideCompletionItems: (doc, pos) => this.complete(doc, pos) }, '.', '"', '['),
    );
    soon(300);
  }

  private enabled(): boolean {
    return vscode.workspace.getConfiguration('planLens').get<boolean>('inlineValues', true) && vscode.workspace.isTrusted;
  }

  /** Root module files of the env, as visible editors. */
  private editors(): vscode.TextEditor[] {
    const root = this.store.env?.root;
    if (!root) return [];
    return vscode.window.visibleTextEditors.filter((e) => e.document.uri.scheme === 'file' && e.document.fileName.endsWith('.tf') && path.dirname(e.document.uri.fsPath) === root);
  }

  private overlays(): Map<string, string> {
    const m = new Map<string, string>();
    for (const d of vscode.workspace.textDocuments) if (d.isDirty && d.fileName.endsWith('.tf')) m.set(d.uri.fsPath, d.getText());
    return m;
  }

  private async refresh(): Promise<void> {
    if (!this.enabled()) {
      for (const e of vscode.window.visibleTextEditors) { e.setDecorations(this.deco, []); e.setDecorations(this.errDeco, []); }
      return;
    }
    // One evaluation at a time; changes meanwhile get one more round after it.
    if (this.busy) { this.again = true; return; }
    const env = this.store.env;
    const editors = this.editors();
    if (!env || !editors.length) return;
    const todo = editors.filter((e) => {
      const s = this.shown.get(e.document.uri.toString());
      return !s || s.version !== e.document.version || s.env !== env.name;
    });
    if (!todo.length) return this.paint();
    this.busy = true;
    try {
      const docs = [...new Set(todo.map((e) => e.document))];
      const perDoc = docs.map((d) => evalTargets(d.getText()));
      const exprs = [...new Set(perDoc.flat().map((t) => t.expr))];
      const first = !this.shown.size;
      const job = this.evaluator.evaluate(env, exprs, this.overlays());
      if (first) vscode.window.setStatusBarMessage(`$(sync~spin) Plan Lens: evaluating values for ${env.name}…`, job);
      const values = await job;
      const byExpr = new Map(exprs.map((e, i) => [e, values[i]]));
      // Mid-edit the configuration often does not load at all: keep the last good values rather than one error each.
      const broken = values.length > 1 && values.every((v) => v.kind === 'error' && v.message === (values[0] as { message: string }).message);
      docs.forEach((d, k) => {
        if (broken && this.shown.has(d.uri.toString())) return;
        const byLine = new Map<number, Shown>();
        for (const t of perDoc[k]) byLine.set(t.line, { target: t, value: byExpr.get(t.expr)! });
        this.shown.set(d.uri.toString(), { version: d.version, env: env.name, byLine });
      });
      this.lastFailure = '';
    } catch (e) {
      const msg = (e as Error).message;
      if (msg !== this.lastFailure) {
        this.lastFailure = msg;
        this.log(`Values: ${msg}`);
        vscode.window.setStatusBarMessage(`$(warning) Plan Lens: no values (${msg.slice(0, 80)}) — see the log`, 8000);
      }
    } finally {
      this.busy = false;
    }
    this.paint();
    if (this.again) { this.again = false; void this.refresh(); }
  }

  private paint(): void {
    for (const e of vscode.window.visibleTextEditors) {
      const s = this.shown.get(e.document.uri.toString());
      const ok: vscode.DecorationOptions[] = [];
      const bad: vscode.DecorationOptions[] = [];
      // Lines moved since the values were computed would show them on the wrong line: wait for the next round.
      if (s && s.version === e.document.version) {
        for (const [line, v] of s.byLine) {
          if (line >= e.document.lineCount) continue;
          const opt = { range: e.document.lineAt(line).range, renderOptions: { after: { contentText: valueText(v.target, v.value) } } };
          (v.value.kind === 'error' ? bad : ok).push(opt);
        }
      }
      e.setDecorations(this.deco, ok);
      e.setDecorations(this.errDeco, bad);
    }
  }

  private hover(doc: vscode.TextDocument, pos: vscode.Position): vscode.Hover | undefined {
    const p = this.picked;
    if (p && p.uri === doc.uri.toString() && p.range.contains(pos)) return new vscode.Hover(this.markdown(p.expr, p.value, 'value'), p.range);
    const v = this.shown.get(doc.uri.toString())?.byLine.get(pos.line);
    if (!v) return undefined;
    return new vscode.Hover(this.markdown(v.target.expr, v.value, v.target.kind), doc.lineAt(pos.line).range);
  }

  private markdown(expr: string, v: EvalValue, kind: string): vscode.MarkdownString {
    const env = this.store.env?.name ?? '';
    const md = new vscode.MarkdownString(undefined, true);
    md.appendMarkdown(`$(symbol-variable) **Value** · ${env}${kind === 'instances' ? ' · instances' : ''}\n\n`);
    if (expr.length < 400) md.appendCodeblock(expr, 'terraform');
    if (v.kind === 'value') {
      if (kind === 'instances') md.appendMarkdown(`${instancesValue(v.value, 400)}\n\n`);
      const pretty = prettyValue(v.value);
      md.appendCodeblock(pretty.split('\n').length > 200 ? pretty.split('\n').slice(0, 200).join('\n') + '\n…' : pretty, 'terraform');
    } else if (v.kind === 'unknown') md.appendMarkdown('*(known after apply)*: it depends on a resource attribute only the cloud knows.\n\n');
    else if (v.kind === 'sensitive') md.appendMarkdown('*(sensitive)*: not shown.\n\n');
    else md.appendMarkdown(`$(warning) ${v.message.replace(/[<>]/g, '')}\n\n`);
    md.appendMarkdown(`*terraform console on Plan Lens's own copy, ${env} variables, empty state.*`);
    return md;
  }

  /** A value for completions: one already shown, else evaluated now (and kept until the files change). */
  private async valueOf(expr: string): Promise<EvalValue | undefined> {
    const env = this.store.env;
    if (!env) return undefined;
    for (const s of this.shown.values()) {
      if (s.env !== env.name) continue;
      for (const v of s.byLine.values()) if (v.target.expr === expr) return v.value;
    }
    const edits = vscode.workspace.textDocuments.filter((d) => d.fileName.endsWith('.tf')).map((d) => `${d.uri}@${d.version}`).join('|');
    const key = `${env.name}|${expr}`;
    const hit = this.asked.get(key);
    if (hit && hit.edits === edits) return hit.value;
    let [value] = await this.evaluator.evaluate(env, [expr], this.overlays());
    // The line being typed usually breaks the file for a moment: the saved files then.
    if (value.kind === 'error') [value] = await this.evaluator.evaluate(env, [expr], new Map());
    this.asked.set(key, { edits, value });
    return value;
  }

  /** Keys the value at the cursor really has: `local.x.`, `var.x["`, `each.value.` (from the block's for_each). */
  private async complete(doc: vscode.TextDocument, pos: vscode.Position): Promise<vscode.CompletionItem[] | undefined> {
    const env = this.store.env;
    if (!this.enabled() || !vscode.workspace.getConfiguration('planLens').get<boolean>('completions', true)) return undefined;
    if (!env || doc.uri.scheme !== 'file' || path.dirname(doc.uri.fsPath) !== env.root) return undefined;
    const line = doc.lineAt(pos.line).text;
    const spot = completionSpot(line.slice(0, pos.character));
    if (!spot) return undefined;
    let values: unknown[];
    if (spot.root === 'each.value') {
      const block = scanBlocks(doc.getText()).find((b) => pos.line >= b.startLine && pos.line <= b.endLine);
      const fe = block && evalTargets(doc.getText()).find((t) => t.kind === 'instances' && t.line > block.startLine && t.line < block.endLine);
      const v = fe && (await this.valueOf(fe.expr));
      if (v?.kind !== 'value') return undefined;
      values = eachValues(v.value).map((x) => walk(x, spot.path));
    } else {
      const v = await this.valueOf(spot.root);
      if (v?.kind !== 'value') return undefined;
      values = [walk(v.value, spot.path)];
    }
    const keys = keysOf(values);
    const typedStart = pos.translate(0, -spot.typed.length);
    const closed = line.slice(pos.character).startsWith('"]');
    return keys.map((k) => {
      const item = new vscode.CompletionItem({ label: k.key, description: k.detail }, /^\d+$/.test(k.key) ? vscode.CompletionItemKind.Value : vscode.CompletionItemKind.Field);
      item.sortText = String(k.order).padStart(5, '0');
      item.detail = `${env.name} · Plan Lens`;
      item.filterText = k.key;
      if (spot.trigger === '.' && !IDENT.test(k.key)) {
        // Not a valid attribute name: index it instead, replacing the dot.
        item.range = new vscode.Range(typedStart.translate(0, -1), pos);
        item.insertText = /^\d+$/.test(k.key) ? `[${k.key}]` : `["${k.key}"]`;
        item.filterText = `.${k.key}`;
      } else if (spot.trigger === '["') {
        item.range = new vscode.Range(typedStart, pos);
        item.insertText = closed ? k.key : `${k.key}"]`;
      } else if (spot.trigger === '[') {
        item.range = new vscode.Range(typedStart, pos);
        item.insertText = /^\d+$/.test(k.key) ? `${k.key}]` : `"${k.key}"]`;
      } else {
        item.range = new vscode.Range(typedStart, pos);
        item.insertText = k.key;
      }
      return item;
    });
  }

  /** Evaluates the selected expression (root module scope) and shows it in a hover there. */
  private async evaluateSelection(): Promise<void> {
    const e = vscode.window.activeTextEditor;
    const env = this.store.env;
    if (!e || e.selection.isEmpty) return void vscode.window.showInformationMessage('Plan Lens: select an expression to evaluate.');
    if (!env) return void vscode.window.showInformationMessage('Plan Lens: pick an environment first; values use its variables.');
    if (path.dirname(e.document.uri.fsPath) !== env.root) {
      return void vscode.window.showInformationMessage(`Plan Lens: values are evaluated in the root module (${path.basename(env.root)}); this file is not in it.`);
    }
    const expr = e.document.getText(e.selection).trim();
    try {
      const [value] = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Plan Lens: evaluating…' },
        () => this.evaluator.evaluate(env, [expr], this.overlays()));
      this.picked = { uri: e.document.uri.toString(), range: e.selection, expr, value };
      await vscode.commands.executeCommand('editor.action.showHover');
    } catch (err) {
      void vscode.window.showErrorMessage(`Plan Lens: ${(err as Error).message}`);
    }
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.subs.forEach((s) => s.dispose());
    this.deco.dispose();
    this.errDeco.dispose();
  }
}
