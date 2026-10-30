import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as vscode from 'vscode';
import { SETTINGS, validSetting } from '../model/settings';

/** Plan Lens settings in an editor tab (one at a time): every option, and a live preview of the sidebar. */
export class SettingsPanel implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private readonly subs: vscode.Disposable[] = [];

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly envFolder: () => string,
    private readonly actions: { envFolder: () => void; findWorkspaces: () => void },
  ) {
    this.subs.push(vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('planLens') && this.post()));
  }

  show(): void {
    if (this.panel) return this.panel.reveal();
    const root = vscode.Uri.joinPath(this.ctx.extensionUri, 'webview');
    const panel = vscode.window.createWebviewPanel('planLens.settings', 'Plan Lens settings', vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [root] });
    panel.iconPath = vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'activity.svg');
    const nonce = randomBytes(16).toString('base64');
    const uri = (...p: string[]) => panel.webview.asWebviewUri(vscode.Uri.joinPath(root, ...p)).toString();
    panel.webview.html = readFileSync(vscode.Uri.joinPath(root, 'settings.html').fsPath, 'utf8')
      .replace(/\{\{cspSource\}\}/g, panel.webview.cspSource)
      .replace(/\{\{nonce\}\}/g, nonce)
      .replace('{{codicon}}', uri('vendor', 'codicon.css'))
      .replace('{{base}}', uri('base.css'))
      .replace('{{css}}', uri('planView.css'))
      .replace('{{settingsCss}}', uri('settings.css'))
      .replace('{{js}}', uri('settings.js'));
    panel.webview.onDidReceiveMessage((m: { type: string; key?: string; value?: unknown }) => {
      switch (m.type) {
        case 'ready': return this.post();
        case 'setting': {
          // Only what the list holds, with a value of its kind; Apply stays a per-workspace choice.
          const ok = validSetting(m.key, m.value);
          if (!ok) return;
          const target = ok.def.workspace && vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
          return void vscode.workspace.getConfiguration('planLens').update(ok.def.key, ok.def.type === 'string' && !ok.value ? undefined : ok.value, target);
        }
        case 'settings': return void vscode.commands.executeCommand('workbench.action.openSettings', '@ext:jay-boo.tf-plan-lens');
        case 'envFolder': return this.actions.envFolder();
        case 'findWorkspaces': return this.actions.findWorkspaces();
      }
    });
    panel.onDidDispose(() => (this.panel = undefined));
    this.panel = panel;
  }

  private post(): void {
    if (!this.panel) return;
    const config = vscode.workspace.getConfiguration('planLens');
    const settings = SETTINGS.map((d) => ({ ...d, value: config.get(d.key, d.default) }));
    void this.panel.webview.postMessage({ type: 'model', model: { settings, envFolder: this.envFolder() } });
  }

  dispose(): void {
    this.panel?.dispose();
    this.subs.forEach((s) => s.dispose());
  }
}
