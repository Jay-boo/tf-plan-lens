import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { toViewModel } from '../model/viewModel';
import { PlanStore } from '../state';

export type ViewMessage =
  | { type: 'ready' | 'run' | 'load' | 'cancel' | 'clear' | 'log' | 'pickEnv'; env?: string }
  | { type: 'open' | 'copy'; address: string };

export class PlanViewProvider implements vscode.WebviewViewProvider {
  static readonly id = 'planLens.view';
  private view?: vscode.WebviewView;

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly store: PlanStore,
    private readonly envNames: () => string[],
    private readonly onMessage: (m: ViewMessage) => void,
  ) {
    ctx.subscriptions.push(store.onDidChange(() => this.post()));
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
    const model = toViewModel(s.plan, {
      env: s.plan?.env || s.env?.name,
      envs: this.envNames(),
      running: s.running,
      now: Date.now(),
      rootName: s.root ? path.basename(s.root) : '',
      locate: (c) => s.locate(c.address),
      error: s.error,
    });
    void this.view.webview.postMessage({ type: 'model', model });
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
