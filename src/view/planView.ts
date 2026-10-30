import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { PlanLog } from '../log';
import { toViewModel } from '../model/viewModel';
import { PlanStore } from '../state';

export type ViewMessage =
  | { type: 'ready' | 'load' | 'cancel' | 'clear' | 'log' | 'pickEnv' | 'apply' | 'envFolder' | 'settings'; env?: string }
  /** targets: re-plan with -target (a targeted Re-plan keeps them; none is a full plan). */
  | { type: 'run'; env?: string; targets?: string[] }
  | { type: 'open' | 'copy'; address: string };

export class PlanViewProvider implements vscode.WebviewViewProvider {
  static readonly id = 'planLens.view';
  private view?: vscode.WebviewView;
  private tailTimer?: NodeJS.Timeout;

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly store: PlanStore,
    private readonly log: PlanLog,
    private readonly info: () => { envs: string[]; envFolder: string; canApply: boolean; applyOff: boolean },
    private readonly onMessage: (m: ViewMessage) => void,
  ) {
    ctx.subscriptions.push(store.onDidChange(() => this.post()), log.onDidAppend(() => this.postTail()), { dispose: () => clearTimeout(this.tailTimer) });
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const webviewRoot = vscode.Uri.joinPath(this.ctx.extensionUri, 'webview');
    view.webview.options = { enableScripts: true, localResourceRoots: [webviewRoot] };
    view.webview.html = this.html(view.webview, webviewRoot);
    view.webview.onDidReceiveMessage((m: ViewMessage) => (m.type === 'ready' ? this.post() : this.onMessage(m)));
    view.onDidChangeVisibility(() => view.visible && this.post());
    view.onDidDispose(() => (this.view = undefined));
  }

  reveal(address: string): void {
    void vscode.commands.executeCommand(`${PlanViewProvider.id}.focus`).then(() => {
      setTimeout(() => void this.view?.webview.postMessage({ type: 'reveal', address }), 150);
    });
  }

  post(): void {
    if (!this.view) return;
    const s = this.store;
    const info = this.info();
    const model = toViewModel(s.plan, {
      env: s.plan?.env || s.env?.name,
      runEnv: s.running ? s.runEnv : undefined,
      envs: info.envs,
      envFolder: info.envFolder,
      canApply: info.canApply,
      applyOff: info.applyOff,
      running: s.running,
      applying: s.applying,
      now: Date.now(),
      rootName: s.root ? path.basename(s.root) : '',
      locate: (c) => s.locate(c.address),
      error: s.error,
      tail: s.running ? this.log.tail() : [],
    });
    void this.view.webview.postMessage({ type: 'model', model });
  }

  /** The live log tail while a run goes, at most every 150 ms; only the tail box changes, not the whole view. */
  private postTail(): void {
    if (this.tailTimer || !this.store.running) return;
    this.tailTimer = setTimeout(() => {
      this.tailTimer = undefined;
      void this.view?.webview.postMessage({ type: 'tail', lines: this.log.tail() });
    }, 150);
  }

  private html(webview: vscode.Webview, root: vscode.Uri): string {
    const nonce = randomBytes(16).toString('base64');
    const uri = (...p: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(root, ...p)).toString();
    const template = require('node:fs').readFileSync(vscode.Uri.joinPath(root, 'planView.html').fsPath, 'utf8') as string;
    return template
      .replace(/\{\{cspSource\}\}/g, webview.cspSource)
      .replace(/\{\{nonce\}\}/g, nonce)
      .replace('{{codicon}}', uri('vendor', 'codicon.css'))
      .replace('{{base}}', uri('base.css'))
      .replace('{{css}}', uri('planView.css'))
      .replace('{{js}}', uri('planView.js'));
  }
}
