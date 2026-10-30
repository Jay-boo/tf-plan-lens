import { readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { Evaluator } from '../evaluator';
import { EvalValue, InstanceValue, inlineValue, instancesValue, prettyValue } from '../model/evalBatch';
import { IDENT, completionSpot, eachValues, keysOf, walk } from '../model/complete';
import { EvalTarget, evalTargets } from '../model/evalTargets';
import { scanBlocks } from '../model/hclScanner';
import { localModuleDirs } from '../model/roots';
import { PlanStore } from '../state';

interface Shown {
  target: EvalTarget;
  /** One per instance of the module the file is in (one unlabelled value in the root). */
  values: InstanceValue[];
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

/** In a module: the first instance's value, which instance it is, and how many more (`· lakebase_spn (+1)`). */
export function instancesText(t: EvalTarget, values: InstanceValue[]): string {
  const [first] = values;
  const text = valueText(t, first.value);
  if (!first.label || first.value.kind === 'error') return text;
  const more = values.length > 1 ? ` (+${values.length - 1})` : '';
  return `${text}  · ${first.label.replace(/^module\./, '')}${more}`;
}

/**
 * Inline values: what locals, variables, for_each / count and outputs of the env's root module — and of the modules it
 * calls, per instance — evaluate to, at the end of their line and in a hover, computed by terraform console on Plan
 * Lens's own copy of the configuration.
 */
export class InlineValues implements vscode.Disposable {
  // A soft pill in the inlay-hint colours, apart from the plan's coloured hints (VS Code has no padding or radius
  // option: they ride on textDecoration).
  private readonly deco = vscode.window.createTextEditorDecorationType({
    after: {
      color: new vscode.ThemeColor('editorInlayHint.foreground'), backgroundColor: new vscode.ThemeColor('editorInlayHint.background'),
      margin: '0 0 0 2.5em', fontStyle: 'normal', textDecoration: 'none; border-radius: 4px; padding: 0 6px',
    },
  });
  private readonly errDeco = vscode.window.createTextEditorDecorationType({
    after: { color: new vscode.ThemeColor('editorWarning.foreground'), margin: '0 0 0 2.5em', fontStyle: 'italic' },
  });
  /** By document: its version when evaluated, and the values by line. */
  private readonly shown = new Map<string, { version: number; env: string; byLine: Map<number, Shown> }>();
  /** Evaluate selection's last result, shown by the hover at that spot. */
  private picked?: { uri: string; range: vscode.Range; expr: string; values: InstanceValue[] };
  private readonly subs: vscode.Disposable[] = [];
  private timer?: NodeJS.Timeout;
  private busy = false;
  private again = false;
  private envKey = '';
  private lastFailure = '';
  /** Values evaluated for completions, by env and expression, with the edits they were made with. */
  private readonly asked = new Map<string, { edits: string; values: InstanceValue[] }>();

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

  /** The folder whose scope values of this file are evaluated in: the env's root, or a module folder the root calls. */
  private scopeOf(file: string): string | undefined {
    const root = this.store.env?.root;
    if (!root || !file.endsWith('.tf')) return undefined;
    const dir = path.dirname(file);
    if (dir === root) return root;
    // Module folders called from the root's own files (the evaluator reads the calls the same way).
    const text = (f: string) => vscode.workspace.textDocuments.find((d) => d.uri.fsPath === f)?.getText() ?? readFileSync(f, 'utf8');
    let called: string[] = [];
    try {
      called = readdirSync(root).filter((f) => f.endsWith('.tf')).flatMap((f) => localModuleDirs(root, text(path.join(root, f))));
    } catch {
      return undefined;
    }
    return called.some((d) => path.resolve(d) === path.resolve(dir)) ? dir : undefined;
  }

  /** Visible .tf files in the env's root or in a module it calls. */
  private editors(): vscode.TextEditor[] {
    return vscode.window.visibleTextEditors.filter((e) => e.document.uri.scheme === 'file' && this.scopeOf(e.document.uri.fsPath));
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
      // One evaluation per scope: the root, and each module folder shown.
      const byScope = new Map<string, vscode.TextDocument[]>();
      for (const d of new Set(todo.map((e) => e.document))) {
        const scope = this.scopeOf(d.uri.fsPath)!;
        byScope.set(scope, [...(byScope.get(scope) ?? []), d]);
      }
      const first = !this.shown.size;
      for (const [scope, docs] of byScope) {
        const perDoc = docs.map((d) => evalTargets(d.getText()));
        const exprs = [...new Set(perDoc.flat().map((t) => t.expr))];
        if (!exprs.length) continue;
        const job = this.evaluator.evaluate(env, exprs, this.overlays(), scope);
        if (first) vscode.window.setStatusBarMessage(`$(sync~spin) Plan Lens: evaluating values for ${env.name}…`, job);
        const values = await job;
        const byExpr = new Map(exprs.map((e, i) => [e, values[i]]));
        // Mid-edit the configuration often does not load at all: keep the last good values rather than one error each.
        const firstMsg = values[0][0].value.kind === 'error' ? values[0][0].value.message : undefined;
        const broken = values.length > 1 && firstMsg !== undefined && values.every((v) => v[0].value.kind === 'error' && v[0].value.message === firstMsg);
        docs.forEach((d, k) => {
          if (broken && this.shown.has(d.uri.toString())) return;
          const byLine = new Map<number, Shown>();
          for (const t of perDoc[k]) byLine.set(t.line, { target: t, values: byExpr.get(t.expr)! });
          this.shown.set(d.uri.toString(), { version: d.version, env: env.name, byLine });
        });
      }
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
          const opt = { range: e.document.lineAt(line).range, renderOptions: { after: { contentText: instancesText(v.target, v.values) } } };
          (v.values[0].value.kind === 'error' ? bad : ok).push(opt);
        }
      }
      e.setDecorations(this.deco, ok);
      e.setDecorations(this.errDeco, bad);
    }
  }

  private hover(doc: vscode.TextDocument, pos: vscode.Position): vscode.Hover | undefined {
    const p = this.picked;
    if (p && p.uri === doc.uri.toString() && p.range.contains(pos)) return new vscode.Hover(this.markdown(p.expr, p.values, 'value'), p.range);
    const v = this.shown.get(doc.uri.toString())?.byLine.get(pos.line);
    if (!v) return undefined;
    return new vscode.Hover(this.markdown(v.target.expr, v.values, v.target.kind), doc.lineAt(pos.line).range);
  }

  private markdown(expr: string, values: InstanceValue[], kind: string): vscode.MarkdownString {
    const env = this.store.env?.name ?? '';
    const md = new vscode.MarkdownString(undefined, true);
    const inModule = !!values[0].label;
    md.appendMarkdown(`$(symbol-variable) **Value** · ${env}${kind === 'instances' ? ' · instances' : ''}${inModule ? ` · ${values.length} module instance${values.length > 1 ? 's' : ''}` : ''}\n\n`);
    if (expr.length < 400) md.appendCodeblock(expr, 'terraform');
    // In a module, each instance in turn (the first ones: a module called 50 times would drown the hover).
    for (const { label, value: v } of values.slice(0, 8)) {
      if (label) md.appendMarkdown(`**\`${label}\`**\n\n`);
      if (v.kind === 'value') {
        if (kind === 'instances') md.appendMarkdown(`${instancesValue(v.value, 400)}\n\n`);
        const pretty = prettyValue(v.value);
        const limit = inModule ? 40 : 200;
        md.appendCodeblock(pretty.split('\n').length > limit ? pretty.split('\n').slice(0, limit).join('\n') + '\n…' : pretty, 'terraform');
      } else if (v.kind === 'unknown') md.appendMarkdown('*(known after apply)*: it depends on a resource attribute only the cloud knows.\n\n');
      else if (v.kind === 'sensitive') md.appendMarkdown('*(sensitive)*: not shown.\n\n');
      else md.appendMarkdown(`$(warning) ${v.message.replace(/[<>]/g, '')}\n\n`);
    }
    if (values.length > 8) md.appendMarkdown(`*+ ${values.length - 8} more instances*\n\n`);
    md.appendMarkdown(`*terraform console on Plan Lens's own copy, ${env} variables, empty state.*`);
    return md;
  }

  /** The values of an expression in a scope, for completions: already shown, else evaluated now (kept until the files change). */
  private async valueOf(expr: string, scope: string): Promise<unknown[]> {
    const env = this.store.env;
    if (!env) return [];
    const ok = (vs: InstanceValue[]) => vs.flatMap((x) => (x.value.kind === 'value' ? [x.value.value] : []));
    for (const [uri, s] of this.shown) {
      if (s.env !== env.name || path.dirname(vscode.Uri.parse(uri).fsPath) !== scope) continue;
      for (const v of s.byLine.values()) if (v.target.expr === expr) return ok(v.values);
    }
    const edits = vscode.workspace.textDocuments.filter((d) => d.fileName.endsWith('.tf')).map((d) => `${d.uri}@${d.version}`).join('|');
    const key = `${env.name}|${scope}|${expr}`;
    const hit = this.asked.get(key);
    if (hit && hit.edits === edits) return ok(hit.values);
    let [values] = await this.evaluator.evaluate(env, [expr], this.overlays(), scope);
    // The line being typed usually breaks the file for a moment: the saved files then.
    if (values[0].value.kind === 'error') [values] = await this.evaluator.evaluate(env, [expr], new Map(), scope);
    this.asked.set(key, { edits, values });
    return ok(values);
  }

  /** Keys the value at the cursor really has: `local.x.`, `var.x["`, `each.value.` (from the block's for_each). */
  private async complete(doc: vscode.TextDocument, pos: vscode.Position): Promise<vscode.CompletionItem[] | undefined> {
    const env = this.store.env;
    if (!this.enabled() || !vscode.workspace.getConfiguration('planLens').get<boolean>('completions', true)) return undefined;
    const scope = doc.uri.scheme === 'file' ? this.scopeOf(doc.uri.fsPath) : undefined;
    if (!env || !scope) return undefined;
    const line = doc.lineAt(pos.line).text;
    const spot = completionSpot(line.slice(0, pos.character));
    if (!spot) return undefined;
    let values: unknown[];
    if (spot.root === 'each.value') {
      const block = scanBlocks(doc.getText()).find((b) => pos.line >= b.startLine && pos.line <= b.endLine);
      const fe = block && evalTargets(doc.getText()).find((t) => t.kind === 'instances' && t.line > block.startLine && t.line < block.endLine);
      if (!fe) return undefined;
      // Every instance's for_each: the keys any element has.
      values = (await this.valueOf(fe.expr, scope)).flatMap((v) => eachValues(v).map((x) => walk(x, spot.path)));
    } else {
      values = (await this.valueOf(spot.root, scope)).map((v) => walk(v, spot.path));
    }
    if (!values.length) return undefined;
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

  /** Evaluates the selected expression (in the file's scope: the root or a module) and shows it in a hover there. */
  private async evaluateSelection(): Promise<void> {
    const e = vscode.window.activeTextEditor;
    const env = this.store.env;
    if (!e || e.selection.isEmpty) return void vscode.window.showInformationMessage('Plan Lens: select an expression to evaluate.');
    if (!env) return void vscode.window.showInformationMessage('Plan Lens: pick an environment first; values use its variables.');
    const scope = this.scopeOf(e.document.uri.fsPath);
    if (!scope) {
      return void vscode.window.showInformationMessage(`Plan Lens: values are evaluated in ${path.basename(env.root)} and the modules it calls; this file is in neither.`);
    }
    const expr = e.document.getText(e.selection).trim();
    try {
      const [values] = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Plan Lens: evaluating…' },
        () => this.evaluator.evaluate(env, [expr], this.overlays(), scope));
      this.picked = { uri: e.document.uri.toString(), range: e.selection, expr, values };
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
