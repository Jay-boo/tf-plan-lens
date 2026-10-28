import * as vscode from 'vscode';
import { PlanStore } from './state';

export class PlanStatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  private readonly timer = setInterval(() => this.update(), 60_000);
  private readonly sub: vscode.Disposable;

  constructor(private readonly store: PlanStore) {
    this.item.command = 'planLens.view.focus';
    this.sub = store.onDidChange(() => this.update());
    this.update();
  }

  update(): void {
    const s = this.store;
    if (s.running) {
      this.item.text = `$(loading~spin) Planning ${s.env?.name ?? ''}`.trimEnd();
      this.item.backgroundColor = undefined;
      this.item.tooltip = 'Terraform Plan Lens: running terraform plan';
      this.item.show();
      return;
    }
    const plan = s.plan;
    if (!plan) return this.item.hide();
    const n = { replace: 0, destroy: 0, other: 0 };
    for (const c of plan.changes) {
      if (c.action === 'replace') n.replace++;
      else if (c.action === 'destroy' || c.action === 'forget') n.destroy++;
      else if (c.action !== 'noop' && c.action !== 'read') n.other++;
    }
    const min = Math.floor((Date.now() - plan.loadedAt) / 60_000);
    const age = min < 1 ? 'now' : min < 60 ? `${min}m` : `${Math.floor(min / 60)}h`;
    const risky = [n.replace && `${n.replace} replace`, n.destroy && `${n.destroy} destroy`].filter(Boolean).join(' · ');
    const label = plan.env || 'file';
    this.item.text = `$(checklist) Plan ${label} · ${age} · ${risky || (n.other ? `${n.other} change${n.other === 1 ? '' : 's'}` : 'no changes')}`;
    this.item.backgroundColor = risky ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    this.item.tooltip = 'Terraform Plan Lens: show the plan';
    this.item.show();
  }

  dispose(): void {
    clearInterval(this.timer);
    this.sub.dispose();
    this.item.dispose();
  }
}
