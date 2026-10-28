import { existsSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { Decorations } from './editor/decorations';
import { registerHover } from './editor/hover';
import { Env, envsFromFiles, findRoot } from './model/envs';
import { looksLikeOtherRoot } from './model/matcher';
import { parsePlan } from './model/planParser';
import { RunError, Runner } from './runner';
import { PlanStore } from './state';
import { PlanStatusBar } from './statusBar';
import { PlanViewProvider, ViewMessage } from './view/planView';

const ENV_KEY = 'planLens.env';

export function activate(ctx: vscode.ExtensionContext): void {
  const out = vscode.window.createOutputChannel('Plan Lens');
  const store = new PlanStore();
  const config = () => vscode.workspace.getConfiguration('planLens');
  const runner = new Runner(out, ctx.globalStorageUri.fsPath, () => config().get<string>('terraformPath') || 'terraform');
  let envs: Env[] = [];
  let cancel: vscode.CancellationTokenSource | undefined;

  /** Terraform root and its environments, from the settings and the workspace. */
  async function discover(): Promise<string | undefined> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const glob = config().get<string>('environmentGlob') || 'environments/**/terraform.tfvars';
    const files = (await vscode.workspace.findFiles(glob, '**/{.terraform,node_modules}/**')).map((u) => u.fsPath);
    let root = config().get<string>('root') || '';
    if (root && !path.isAbsolute(root) && folders[0]) root = path.join(folders[0].uri.fsPath, root);
    if (!root && files.length) root = findRoot(files.sort()[0]);
    if (!root) {
      const tf = await vscode.workspace.findFiles('**/*.tf', '**/{.terraform,node_modules}/**', 1);
      if (tf[0]) root = vscode.workspace.getWorkspaceFolder(tf[0])?.uri.fsPath ?? path.dirname(tf[0].fsPath);
    }
    const under = files.filter((f) => !path.relative(root, f).startsWith('..'));
    envs = root ? envsFromFiles(root, under, existsSync) : [];
    if (!store.root && root) store.root = root;
    const saved = ctx.workspaceState.get<string>(ENV_KEY);
    store.env = envs.find((e) => e.name === (store.env?.name ?? saved)) ?? (envs.length === 1 ? envs[0] : store.env);
    store.touch();
    return root || undefined;
  }

  async function pickEnv(): Promise<Env | undefined> {
    await discover();
    if (!envs.length) {
      void vscode.window.showWarningMessage('Plan Lens: no environments found. Set "planLens.environmentGlob" or load a plan file.', 'Open settings')
        .then((b) => b && vscode.commands.executeCommand('workbench.action.openSettings', 'planLens'));
      return undefined;
    }
    const pick = await vscode.window.showQuickPick(
      envs.map((e) => ({ label: e.name, description: e.backendConf ? 'tfvars + backend.conf' : 'tfvars', env: e })),
      { placeHolder: 'Environment to plan' },
    );
    if (!pick) return undefined;
    store.env = pick.env;
    await ctx.workspaceState.update(ENV_KEY, pick.env.name);
    store.touch();
    return pick.env;
  }

  async function runPlan(envName?: string): Promise<void> {
    // Claimed before any await, so a double click (or view + title bar) can't start two runs.
    if (store.running) return;
    store.setRunning(true);
    const cts = new vscode.CancellationTokenSource();
    cancel = cts;
    try {
      const root = await discover();
      let env = envName ? envs.find((e) => e.name === envName) : store.env;
      if (!env) env = await pickEnv();
      if (!env || !root) return store.setRunning(false);
      store.env = env;
      await ctx.workspaceState.update(ENV_KEY, env.name);
      const json = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Plan Lens: terraform plan ${env.name}`, cancellable: true },
        (_p, token) => {
          token.onCancellationRequested(() => void cancelRun());
          return runner.runPlan(root, env!, cts.token);
        },
      );
      const plan = parsePlan(json, { env: env.name, source: 'run', loadedAt: Date.now() });
      store.running = false;
      await store.setPlan(plan, root);
    } catch (e) {
      failed(e);
    } finally {
      if (cancel === cts) cancel = undefined;
      cts.dispose();
    }
  }

  async function cancelRun(): Promise<void> {
    const cts = cancel;
    if (!cts) return;
    // On Windows the kill is a hard TerminateProcess: terraform can't release a remote state lock.
    if (process.platform === 'win32') {
      const go = await vscode.window.showWarningMessage(
        'Stopping terraform now may leave the remote state locked (you would then need terraform force-unlock). Stop anyway?',
        { modal: true }, 'Stop');
      if (go !== 'Stop') return;
    }
    cts.cancel();
  }

  async function loadPlan(): Promise<void> {
    if (store.running) return void vscode.window.showInformationMessage('Plan Lens: a plan is running; load the file when it is done.');
    const root = await discover();
    const [file] = (await vscode.window.showOpenDialog({
      canSelectMany: false,
      openLabel: 'Load plan',
      defaultUri: root ? vscode.Uri.file(root) : undefined,
      filters: { 'Terraform plan': ['json', 'tfplan', 'plan', 'bin', 'out', '*'] },
    })) ?? [];
    if (!file) return;
    if (!root) return void vscode.window.showWarningMessage('Plan Lens: open the Terraform folder first, so the plan can be put on its files.');
    try {
      let json: unknown;
      if (file.fsPath.toLowerCase().endsWith('.json')) {
        json = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(file)).toString('utf8'));
      } else {
        try {
          json = await runner.showJson(root, file.fsPath);
        } catch (e) {
          throw new RunError(`Could not read this plan file with terraform show (${(e as Error).message}). Run a plan here, or load its JSON (terraform show -json).`, false);
        }
      }
      const plan = parsePlan(json, { env: '', source: file.fsPath, loadedAt: Date.now() });
      await store.setPlan(plan, root);
      if (looksLikeOtherRoot(plan, store.orphans())) {
        // Most root resources have no block here: the plan is probably for another root (landing_zone/, vms/…).
        const b = await vscode.window.showWarningMessage(
          `Plan Lens: this plan doesn't seem to be for ${path.basename(root)}: most of its resources aren't in that folder. Pick the Terraform root it was made for?`,
          'Pick folder…', 'Keep');
        if (b === 'Pick folder…') {
          const [dir] = (await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Use as Terraform root', defaultUri: vscode.Uri.file(root) })) ?? [];
          if (dir) await store.setPlan(plan, dir.fsPath);
        }
      }
    } catch (e) {
      failed(e);
    }
  }

  function failed(e: unknown): void {
    const err = e instanceof RunError ? e : new RunError((e as Error)?.message ?? String(e), false);
    store.setRunning(false, err.cancelled ? undefined : err.message);
    if (err.cancelled) return;
    const actions = err.azureAuth ? ['Open terminal', 'Open log'] : ['Open log'];
    void vscode.window.showErrorMessage(`Plan Lens: ${err.message}`, ...actions).then((b) => {
      if (b === 'Open log') out.show(true);
      if (b === 'Open terminal') {
        const t = vscode.window.createTerminal({ name: 'az login', cwd: store.root });
        t.show();
        t.sendText('az login');
      }
    });
  }

  async function openAddress(address: string): Promise<void> {
    const at = store.locate(address);
    if (!at || !store.root) {
      await vscode.env.clipboard.writeText(address);
      void vscode.window.showInformationMessage(`Plan Lens: ${address} is not in the code (copied the address).`);
      return;
    }
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(store.root, at.file)));
    const pos = new vscode.Position(at.line, 0);
    await vscode.window.showTextDocument(doc, { selection: new vscode.Range(pos, pos), preview: true });
  }

  const view = new PlanViewProvider(ctx, store, () => envs.map((e) => e.name), (m: ViewMessage) => {
    switch (m.type) {
      case 'run': return void runPlan(m.env);
      case 'load': return void loadPlan();
      case 'cancel': return void cancelRun();
      case 'clear': return store.clear();
      case 'log': return out.show(true);
      case 'pickEnv': return void pickEnv();
      case 'open': return void openAddress(m.address);
      case 'copy':
        void vscode.env.clipboard.writeText(m.address);
        return void vscode.window.setStatusBarMessage(`Copied ${m.address}`, 2500);
    }
  });

  ctx.subscriptions.push(
    out,
    store,
    new Decorations(ctx, store),
    new PlanStatusBar(store),
    vscode.window.registerWebviewViewProvider(PlanViewProvider.id, view, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('planLens.runPlan', () => runPlan()),
    vscode.commands.registerCommand('planLens.loadPlan', () => loadPlan()),
    vscode.commands.registerCommand('planLens.clear', () => store.clear()),
    vscode.commands.registerCommand('planLens.openLog', () => out.show(true)),
    vscode.commands.registerCommand('planLens.pickEnv', () => pickEnv()),
    vscode.commands.registerCommand('planLens.reveal', (address: string) => view.reveal(address)),
    vscode.commands.registerCommand('planLens.copyAddress', async (address: string) => {
      await vscode.env.clipboard.writeText(address);
      vscode.window.setStatusBarMessage(`Copied ${address}`, 2500);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('planLens') && void discover()),
    { dispose: () => cancel?.cancel() },
  );
  // The view shows ages ("12 min ago"); refresh it once a minute.
  const tick = setInterval(() => store.plan && store.touch(), 60_000);
  ctx.subscriptions.push({ dispose: () => clearInterval(tick) });
  registerHover(ctx, store);
  void discover();
}

export function deactivate(): void {}
