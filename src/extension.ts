import { existsSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { Decorations } from './editor/decorations';
import { PlanLog } from './log';
import { registerHover } from './editor/hover';
import { Env, StateLock, envsFromFiles, findRoot, rootForEnvFolder } from './model/envs';
import { compactTargets, covers } from './model/targets';
import { looksLikeOtherRoot } from './model/matcher';
import { parsePlan } from './model/planParser';
import { RunError, Runner, SavedPlan } from './runner';
import { PlanStore } from './state';
import { PlanStatusBar } from './statusBar';
import { PlanViewProvider, ViewMessage } from './view/planView';

const ENV_KEY = 'planLens.env';

export function activate(ctx: vscode.ExtensionContext): void {
  const out = new PlanLog();
  const store = new PlanStore();
  const config = () => vscode.workspace.getConfiguration('planLens');
  const runner = new Runner(out, ctx.globalStorageUri.fsPath, () => config().get<string>('terraformPath') || 'terraform');
  let envs: Env[] = [];
  /** Shown in the sidebar: where environments are looked for. */
  let envSource = '';
  let cancel: vscode.CancellationTokenSource | undefined;
  /** The last Run's saved plan: what Apply applies. Only set while store.plan is that run. */
  let saved: SavedPlan | undefined;
  const EXCLUDE = '**/{.terraform,node_modules}/**';
  const hasTf = (dir: string) => {
    try {
      return readdirSync(dir).some((f) => f.endsWith('.tf'));
    } catch {
      return false;
    }
  };
  const fromWorkspace = (p: string) => {
    const base = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return p && !path.isAbsolute(p) && base ? path.join(base, p) : p;
  };

  /** Terraform root and its environments, from the settings and the workspace. */
  async function discover(): Promise<string | undefined> {
    // planLens.environmentsFolder (any folder, even outside the workspace) wins over the glob.
    const envFolder = fromWorkspace(config().get<string>('environmentsFolder') || '');
    const glob = config().get<string>('environmentGlob') || 'environments/**/terraform.tfvars';
    const files = (envFolder
      ? await vscode.workspace.findFiles(new vscode.RelativePattern(vscode.Uri.file(envFolder), '**/*.tfvars'), EXCLUDE)
      : await vscode.workspace.findFiles(glob, EXCLUDE)).map((u) => u.fsPath);
    envSource = envFolder ? `${vscode.workspace.asRelativePath(envFolder, false)}/` : glob;
    let root = fromWorkspace(config().get<string>('root') || '');
    if (!root && envFolder) root = rootForEnvFolder(envFolder, hasTf);
    if (!root && files.length) root = findRoot(files.sort()[0]);
    if (!root) {
      const tf = await vscode.workspace.findFiles('**/*.tf', EXCLUDE, 1);
      if (tf[0]) root = vscode.workspace.getWorkspaceFolder(tf[0])?.uri.fsPath ?? path.dirname(tf[0].fsPath);
    }
    // With a chosen folder every tfvars in it is an env, wherever the root is; the glob ones must sit under the root.
    const under = envFolder ? files : files.filter((f) => !path.relative(root, f).startsWith('..'));
    envs = root ? envsFromFiles(root, under, existsSync, envFolder || undefined) : [];
    // A loaded plan keeps its root; otherwise follow the settings.
    if (root && (!store.root || !store.plan)) store.root = root;
    const saved = ctx.workspaceState.get<string>(ENV_KEY);
    store.env = envs.find((e) => e.name === (store.env?.name ?? saved)) ?? (envs.length === 1 ? envs[0] : store.env);
    store.touch();
    return root || undefined;
  }

  async function pickEnv(): Promise<Env | undefined> {
    await discover();
    if (!envs.length) {
      const b = await vscode.window.showWarningMessage(`Plan Lens: no environments found in ${envSource}. Pick the folder that holds them, or load a plan file.`, 'Pick folder…', 'Open settings');
      if (b === 'Pick folder…') await setEnvFolder();
      if (b === 'Open settings') void vscode.commands.executeCommand('workbench.action.openSettings', 'planLens');
      return undefined;
    }
    type Pick = vscode.QuickPickItem & { env?: Env };
    const items: Pick[] = [
      ...envs.map((e) => ({ label: e.name, description: path.relative(path.dirname(e.dir), e.tfvars) + (e.backendConf ? ' + ' + path.basename(e.backendConf) : ''), env: e })),
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      { label: '$(folder) Change environments folder…', description: envSource },
    ];
    const pick = await vscode.window.showQuickPick(items, { placeHolder: `Environment to plan (from ${envSource})` });
    if (!pick) return undefined;
    if (!pick.env) {
      await setEnvFolder();
      return undefined;
    }
    store.env = pick.env;
    await ctx.workspaceState.update(ENV_KEY, pick.env.name);
    store.touch();
    return pick.env;
  }

  /** terraform plan for an env; with targets, a plan limited to them (-target) and what they depend on. */
  async function runPlan(envName?: string, picked: string[] = []): Promise<void> {
    // Claimed before any await, so a double click (or view + title bar) can't start two runs.
    if (store.running) return;
    store.setRunning(true);
    const cts = new vscode.CancellationTokenSource();
    cancel = cts;
    let root: string | undefined;
    let env: Env | undefined;
    try {
      root = await discover();
      env = envName ? envs.find((e) => e.name === envName) : store.env;
      if (!env) env = await pickEnv();
      if (!env || !root) return store.setRunning(false);
      store.env = env;
      store.runEnv = env.name;
      store.touch();
      await ctx.workspaceState.update(ENV_KEY, env.name);
      const targets = compactTargets(picked);
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Plan Lens: terraform plan ${env.name}${targets.length ? ` (${targets.length} target${targets.length > 1 ? 's' : ''})` : ''}`, cancellable: true },
        (_p, token) => {
          token.onCancellationRequested(() => void cancelRun());
          return runner.runPlan(root!, env!, cts.token, targets);
        },
      );
      const plan = parsePlan(result.json, { env: env.name, source: 'run', loadedAt: Date.now() });
      if (targets.length) plan.targets = targets;
      await runner.discard(saved);
      saved = result.saved;
      store.running = false;
      await store.setPlan(plan, root);
    } catch (e) {
      failed(e, root && env ? { root, env, targets: picked } : undefined);
    } finally {
      if (cancel === cts) cancel = undefined;
      cts.dispose();
    }
  }

  /** After a plan failed on the state lock: says who holds it, and force-unlocks then plans again if the user confirms. */
  async function unlockAndPlan(lock: StateLock, at: { root: string; env: Env; targets: string[] }): Promise<void> {
    if (store.running) return;
    const holder = [lock.who && `by ${lock.who}`, lock.operation && `(${lock.operation})`, lock.created && `since ${lock.created}`].filter(Boolean).join(' ');
    const go = await vscode.window.showWarningMessage(
      `The ${at.env.name} state is locked${holder ? ` ${holder}` : ''}.`,
      {
        modal: true,
        detail: `Lock ID ${lock.id}\n\nForce unlock only if no terraform run is still using this state (a stopped or crashed run leaves its lock behind). Unlocking under a live run can corrupt the state.`,
      },
      'Force unlock and plan');
    if (go !== 'Force unlock and plan') return;
    store.setRunning(true, undefined, false, at.env.name);
    const cts = new vscode.CancellationTokenSource();
    cancel = cts;
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Plan Lens: terraform force-unlock ${at.env.name}` },
        () => runner.forceUnlock(at.root, at.env, lock.id, cts.token),
      );
      store.setRunning(false);
    } catch (e) {
      return failed(e);
    } finally {
      if (cancel === cts) cancel = undefined;
      cts.dispose();
    }
    void runPlan(at.env.name, at.targets);
  }

  /** terraform apply of the saved plan shown in the sidebar, after a confirmation; then a fresh plan. */
  async function apply(): Promise<void> {
    if (store.running) return;
    if (!config().get<boolean>('allowApply')) {
      const b = await vscode.window.showInformationMessage('Plan Lens: Apply is off. Turn on "planLens.allowApply" to apply plans from here.', 'Open setting');
      if (b) void vscode.commands.executeCommand('workbench.action.openSettings', 'planLens.allowApply');
      return;
    }
    const plan = store.plan;
    const s = saved;
    if (!plan || !s || plan.env !== s.env.name) {
      return void vscode.window.showInformationMessage('Plan Lens: run a plan from here first; only a plan run by Plan Lens can be applied.');
    }
    const n = (a: string) => plan.changes.filter((c) => c.action === a).length;
    const destroys = n('destroy') + n('forget');
    const summary = [`${n('create')} to create`, `${n('update')} to update`, `${n('replace')} to replace`, `${destroys} to destroy`].filter((t) => !t.startsWith('0 ')).join(', ');
    if (!summary) return void vscode.window.showInformationMessage('Plan Lens: this plan has no changes to apply.');
    const targets = plan.targets ?? [];
    const targeted = targets.length
      ? `\n\nTargeted plan, limited to:\n${targets.slice(0, 8).map((t) => `  ${t}`).join('\n')}${targets.length > 8 ? `\n  …and ${targets.length - 8} more` : ''}\nplus what they depend on. Other changes stay pending.`
      : '';
    const go = await vscode.window.showWarningMessage(
      `Apply the ${targets.length ? 'targeted ' : ''}plan to ${s.env.name}?`,
      { modal: true, detail: `${summary}.${targeted}\n\nThis runs terraform apply on the plan shown in Plan Lens (${path.basename(s.root)}). Terraform refuses it if the state changed since.` },
      'Apply');
    if (go !== 'Apply') return;
    if (n('replace') + destroys > 0) {
      const typed = await vscode.window.showInputBox({
        title: `This plan destroys or replaces ${n('replace') + destroys} resource(s) in ${s.env.name}`,
        prompt: `Type ${s.env.name} to apply`,
        validateInput: (v) => (v === s.env.name ? undefined : `Type ${s.env.name} exactly`),
        ignoreFocusOut: true,
      });
      if (typed !== s.env.name) return;
    }
    store.setRunning(true, undefined, true, s.env.name);
    const cts = new vscode.CancellationTokenSource();
    cancel = cts;
    out.show(true);
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Plan Lens: terraform apply ${s.env.name}`, cancellable: true },
        (_p, token) => {
          token.onCancellationRequested(() => void cancelRun());
          return runner.apply(s, cts.token);
        },
      );
      // The plan file is spent either way; a fresh plan shows what is left.
      await runner.discard(s);
      if (saved === s) saved = undefined;
      store.setRunning(false);
      void vscode.window.showInformationMessage(`Plan Lens: applied to ${s.env.name}.`);
      void runPlan(s.env.name);
    } catch (e) {
      failed(e);
    } finally {
      if (cancel === cts) cancel = undefined;
      cts.dispose();
    }
  }

  /** Quick pick over the plan's changes and modules, then a plan limited to the picks (-target). */
  async function targetPlan(): Promise<void> {
    const plan = store.plan;
    if (store.running) return;
    if (!plan?.env) return void vscode.window.showInformationMessage('Plan Lens: run a plan from here first; targets are picked from its changes.');
    const changes = plan.changes.filter((c) => c.action !== 'read' && c.action !== 'noop');
    if (!changes.length) return void vscode.window.showInformationMessage('Plan Lens: this plan has no changes to target.');
    const current = plan.targets ?? [];
    type Pick = vscode.QuickPickItem & { address?: string };
    const entry = (address: string, description: string): Pick => ({ label: address, description, address, picked: current.some((t) => covers(t, address)) });
    const modules = [...new Set(changes.map((c) => c.moduleAddress).filter(Boolean))].sort();
    const items: Pick[] = [
      ...(modules.length ? [{ label: 'Modules', kind: vscode.QuickPickItemKind.Separator }] : []),
      ...modules.map((m) => entry(m, `${changes.filter((c) => covers(m, c.address)).length} change(s)`)),
      { label: 'Resources', kind: vscode.QuickPickItemKind.Separator },
      ...changes.map((c) => entry(c.address, c.action)),
    ];
    const picks = await vscode.window.showQuickPick(items, {
      canPickMany: true, matchOnDescription: true,
      title: `Plan Lens: targeted plan for ${plan.env}`,
      placeHolder: 'Pick what to plan (-target); terraform adds what the picks depend on',
    });
    if (!picks?.length) return;
    void runPlan(plan.env, picks.flatMap((p) => (p.address ? [p.address] : [])));
  }

  /** Picks the folder environments are read from (planLens.environmentsFolder), or goes back to the glob. */
  async function setEnvFolder(): Promise<void> {
    const current = fromWorkspace(config().get<string>('environmentsFolder') || '');
    if (current) {
      const how = await vscode.window.showQuickPick(
        [{ label: '$(folder-opened) Choose another folder…', id: 'pick' }, { label: '$(discard) Use the default', description: config().get<string>('environmentGlob'), id: 'reset' }],
        { placeHolder: `Environments come from ${envSource}` });
      if (!how) return;
      if (how.id === 'reset') {
        await config().update('environmentsFolder', undefined, vscode.ConfigurationTarget.Workspace);
        return;
      }
    }
    const start = current || (store.root && path.join(store.root, 'environments')) || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const [dir] = (await vscode.window.showOpenDialog({
      canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
      openLabel: 'Use for environments', title: 'Folder that holds the environments (subfolders with a terraform.tfvars, or *.tfvars files)',
      defaultUri: start && existsSync(start) ? vscode.Uri.file(start) : undefined,
    })) ?? [];
    if (!dir) return;
    // Stored relative to the workspace when inside it, so the setting works for teammates too.
    const rel = vscode.workspace.asRelativePath(dir, false);
    const value = path.isAbsolute(rel) ? dir.fsPath : rel;
    await config().update('environmentsFolder', value, vscode.ConfigurationTarget.Workspace);
    await discover();
    if (!envs.length) void vscode.window.showWarningMessage(`Plan Lens: no *.tfvars found in ${envSource}.`);
    else void vscode.window.setStatusBarMessage(`Plan Lens: ${envs.length} environment(s) in ${envSource}`, 4000);
  }

  async function clearPlan(): Promise<void> {
    store.clear();
    await runner.discard(saved);
    saved = undefined;
  }

  async function cancelRun(): Promise<void> {
    const cts = cancel;
    if (!cts) return;
    if (store.applying) {
      const go = await vscode.window.showWarningMessage(
        'Stopping terraform apply midway can leave resources half changed and the state locked. Stop anyway?',
        { modal: true }, 'Stop apply');
      if (go !== 'Stop apply') return;
      return void cts.cancel();
    }
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
      await runner.discard(saved);
      saved = undefined;
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

  function failed(e: unknown, planned?: { root: string; env: Env; targets: string[] }): void {
    const err = e instanceof RunError ? e : new RunError((e as Error)?.message ?? String(e), false);
    store.setRunning(false, err.cancelled ? undefined : err.message);
    if (err.cancelled) return;
    const lock = planned && err.lock;
    const actions = [...(lock ? ['Force unlock…'] : []), ...(err.azureAuth ? ['Open terminal'] : []), 'Open log'];
    void vscode.window.showErrorMessage(`Plan Lens: ${err.message}`, ...actions).then((b) => {
      if (b === 'Force unlock…' && lock) void unlockAndPlan(lock, planned!);
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

  const viewInfo = () => ({
    envs: envs.map((e) => e.name),
    envFolder: envSource,
    canApply: !!config().get<boolean>('allowApply') && !!saved && store.plan?.env === saved.env.name,
    applyOff: !config().get<boolean>('allowApply') && !!saved && store.plan?.env === saved.env.name,
  });
  const view = new PlanViewProvider(ctx, store, out, viewInfo, (m: ViewMessage) => {
    switch (m.type) {
      case 'run': return void runPlan(m.env, Array.isArray(m.targets) ? m.targets.filter((t) => typeof t === 'string') : []);
      case 'load': return void loadPlan();
      case 'apply': return void apply();
      case 'envFolder': return void setEnvFolder();
      case 'settings': return void vscode.commands.executeCommand('workbench.action.openSettings', 'planLens');
      case 'cancel': return void cancelRun();
      case 'clear': return void clearPlan();
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
    vscode.commands.registerCommand('planLens.clear', () => clearPlan()),
    vscode.commands.registerCommand('planLens.apply', () => apply()),
    vscode.commands.registerCommand('planLens.targetPlan', () => targetPlan()),
    vscode.commands.registerCommand('planLens.setEnvFolder', () => setEnvFolder()),
    vscode.commands.registerCommand('planLens.openLog', () => out.show(true)),
    vscode.commands.registerCommand('planLens.pickEnv', () => pickEnv()),
    vscode.commands.registerCommand('planLens.reveal', (address: string) => view.reveal(address)),
    vscode.commands.registerCommand('planLens.copyAddress', async (address: string) => {
      await vscode.env.clipboard.writeText(address);
      vscode.window.setStatusBarMessage(`Copied ${address}`, 2500);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('planLens') && void discover()),
    { dispose: () => (cancel?.cancel(), void runner.discard(saved)) },
  );
  // The view shows ages ("12 min ago"); refresh it once a minute.
  const tick = setInterval(() => store.plan && store.touch(), 60_000);
  ctx.subscriptions.push({ dispose: () => clearInterval(tick) });
  registerHover(ctx, store);

  // The Plan Lens sidebar (and its activity bar icon) only shows when the workspace has Terraform files.
  const updateHasTerraform = async () => {
    const tf = await vscode.workspace.findFiles('**/*.tf', '**/{.terraform,node_modules}/**', 1);
    await vscode.commands.executeCommand('setContext', 'planLens.hasTerraform', tf.length > 0);
  };
  const watcher = vscode.workspace.createFileSystemWatcher('**/*.tf', false, true, false);
  ctx.subscriptions.push(
    watcher,
    watcher.onDidCreate(() => void updateHasTerraform()),
    watcher.onDidDelete(() => void updateHasTerraform()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => void updateHasTerraform()),
  );
  void updateHasTerraform();
  void discover();
}

export function deactivate(): void {}
