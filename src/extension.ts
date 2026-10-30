import { existsSync, readdirSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { Decorations } from './editor/decorations';
import { PlanLog } from './log';
import { registerHover } from './editor/hover';
import { registerMoveActions } from './editor/moves';
import { EditPreview } from './editor/preview';
import { InlineValues } from './editor/values';
import { Evaluator } from './evaluator';
import { Env, StateLock, envsFromFiles, findRoot, pickBinary, rootForEnvFolder } from './model/envs';
import { compactTargets, covers } from './model/targets';
import { looksLikeOtherRoot } from './model/matcher';
import { movedFroms, movedHcl } from './model/refactor';
import { validSetting } from './model/settings';
import { qualifyNames, rootEnvs, terraformRoots } from './model/roots';
import { parsePlan } from './model/planParser';
import { RunError, Runner, SavedPlan } from './runner';
import { PlanStore } from './state';
import { PlanStatusBar } from './statusBar';
import { PlanViewProvider, ViewMessage } from './view/planView';
import { SettingsPanel } from './view/settingsPanel';

const ENV_KEY = 'planLens.env';
/** root → workspaces found with terraform workspace list (remote backends have no local trace of them). */
const WS_KEY = 'planLens.workspaces';

export function activate(ctx: vscode.ExtensionContext): void {
  const out = new PlanLog();
  const store = new PlanStore();
  const config = () => vscode.workspace.getConfiguration('planLens');
  /** On the PATH (with Windows' extensions): decides between terraform and tofu when no binary is set. */
  const onPath = (name: string) => (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
    .some((dir) => (process.platform === 'win32' ? ['.exe', '.cmd', ''] : ['']).some((ext) => existsSync(path.join(dir, name + ext))));
  let detected: string | undefined;
  const binary = () => {
    const set = config().inspect<string>('terraformPath');
    const explicit = set?.workspaceFolderValue ?? set?.workspaceValue ?? set?.globalValue;
    return explicit || (detected ??= pickBinary(undefined, onPath));
  };
  const runner = new Runner(out, ctx.globalStorageUri.fsPath, binary);
  let envs: Env[] = [];
  /** Roots planned without tfvars (their workspaces can be listed). */
  let plainRoots: string[] = [];
  /** Shown in the sidebar: where environments are looked for. */
  let envSource = '';
  let cancel: vscode.CancellationTokenSource | undefined;
  /** Set by Write & re-plan: what the next plan of that env is compared with, to say how many destroys the moves kept. */
  let refactorCheck: { env: string; destroys: number; kept: number } | undefined;
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

  /** A root as shown in env names: its path in the workspace, or its folder name for a workspace folder itself. */
  const rootName = (root: string) => {
    const rel = vscode.workspace.asRelativePath(root, (vscode.workspace.workspaceFolders?.length ?? 0) > 1);
    return path.isAbsolute(rel) || rel === root ? path.basename(root) : rel;
  };
  /** Workspaces of a root: local ones (terraform.tfstate.d/) and the ones listed earlier from its backend. */
  const workspacesOf = (root: string) => {
    let local: string[] = [];
    try {
      local = readdirSync(path.join(root, 'terraform.tfstate.d'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      // No local workspaces.
    }
    const listed = ctx.workspaceState.get<Record<string, string[]>>(WS_KEY, {})[root] ?? [];
    return [...new Set([...local, ...listed])];
  };
  /** Terraform roots of the workspace; reading every .tf is not free, so kept until a .tf is saved, added or deleted. */
  let rootsCache: Promise<string[]> | undefined;
  const findRoots = () => (rootsCache ??= (async () => {
    const uris = await vscode.workspace.findFiles('**/*.tf', EXCLUDE, 5000);
    const files = await Promise.all(uris.map(async (u) => ({ path: u.fsPath, text: await readFile(u.fsPath, 'utf8').catch(() => '') })));
    return terraformRoots(files);
  })());

  /**
   * Environments from the settings and the workspace: the tfvars ones (environments/ convention or the chosen folder),
   * then every other Terraform root planned as it is, once per workspace. Returns the root of the current env.
   */
  async function discover(): Promise<string | undefined> {
    // planLens.environmentsFolder (any folder, even outside the workspace) wins over the glob, and limits envs to it.
    const envFolder = fromWorkspace(config().get<string>('environmentsFolder') || '');
    const glob = config().get<string>('environmentGlob') || 'environments/**/terraform.tfvars';
    const files = (envFolder
      ? await vscode.workspace.findFiles(new vscode.RelativePattern(vscode.Uri.file(envFolder), '**/*.tfvars'), EXCLUDE)
      : await vscode.workspace.findFiles(glob, EXCLUDE)).map((u) => u.fsPath).sort();
    envSource = envFolder ? `${vscode.workspace.asRelativePath(envFolder, false)}/` : glob;
    const rootSetting = fromWorkspace(config().get<string>('root') || '');
    let tfvarsEnvs: Env[];
    if (envFolder) {
      tfvarsEnvs = envsFromFiles(rootSetting || rootForEnvFolder(envFolder, hasTf), files, existsSync, envFolder);
    } else {
      // Each tfvars plans the root above its environments/ folder (or planLens.root, when it is under it).
      const byRoot = new Map<string, string[]>();
      for (const f of files) {
        const root = rootSetting || findRoot(f);
        if (path.relative(root, f).startsWith('..')) continue;
        byRoot.set(root, [...(byRoot.get(root) ?? []), f]);
      }
      tfvarsEnvs = qualifyNames([...byRoot].flatMap(([root, fs]) => envsFromFiles(root, fs, existsSync)), rootName);
    }
    // Roots with no tfvars env plan as they are.
    const covered = new Set(tfvarsEnvs.map((e) => e.root));
    const roots = envFolder ? [] : rootSetting ? [rootSetting] : await findRoots();
    plainRoots = roots.filter((r) => !covered.has(r));
    envs = [...tfvarsEnvs, ...plainRoots.flatMap((r) => rootEnvs(r, rootName(r), workspacesOf(r)))];
    const saved = ctx.workspaceState.get<string>(ENV_KEY);
    store.env = envs.find((e) => e.name === (store.env?.name ?? saved)) ?? (envs.length === 1 ? envs[0] : store.env);
    // A loaded plan keeps its root; otherwise follow the env.
    const root = store.env?.root ?? envs[0]?.root;
    if (root && (!store.root || !store.plan)) store.root = root;
    store.touch();
    return root;
  }

  /** terraform workspace list on a plain root (picked when there are several); the workspaces become envs. */
  async function findWorkspaces(): Promise<void> {
    if (store.running) return;
    let root = plainRoots[0];
    if (plainRoots.length > 1) {
      const pick = await vscode.window.showQuickPick(plainRoots.map((r) => ({ label: rootName(r), root: r })), { placeHolder: 'Terraform folder whose workspaces to list' });
      if (!pick) return;
      root = pick.root;
    }
    if (!root) return void vscode.window.showInformationMessage('Plan Lens: workspaces are listed for Terraform folders planned without tfvars; none here.');
    store.setRunning(true, undefined, false, rootName(root));
    const cts = new vscode.CancellationTokenSource();
    cancel = cts;
    try {
      const found = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Plan Lens: terraform workspace list (${rootName(root)})`, cancellable: true },
        (_p, token) => {
          token.onCancellationRequested(() => void cancelRun());
          return runner.listWorkspaces({ name: rootName(root), root, dir: root }, cts.token);
        },
      );
      await ctx.workspaceState.update(WS_KEY, { ...ctx.workspaceState.get<Record<string, string[]>>(WS_KEY, {}), [root]: found });
      store.setRunning(false);
      await discover();
      const n = found.filter((w) => w !== 'default').length;
      void vscode.window.setStatusBarMessage(`Plan Lens: ${n} workspace(s) besides default in ${rootName(root)}`, 4000);
      if (n) void pickEnv();
    } catch (e) {
      failed(e);
    } finally {
      if (cancel === cts) cancel = undefined;
      cts.dispose();
    }
  }

  async function pickEnv(): Promise<Env | undefined> {
    await discover();
    if (!envs.length) {
      const where = envSource.endsWith('/') ? envSource : 'this workspace (no Terraform folder or tfvars found)';
      const b = await vscode.window.showWarningMessage(`Plan Lens: no environments found in ${where}. Pick the folder that holds them, or load a plan file.`, 'Pick folder…', 'Open settings');
      if (b === 'Pick folder…') await setEnvFolder();
      if (b === 'Open settings') void vscode.commands.executeCommand('workbench.action.openSettings', 'planLens');
      return undefined;
    }
    type Pick = vscode.QuickPickItem & { env?: Env; id?: 'folder' | 'workspaces' };
    const describe = (e: Env) => e.tfvars
      ? path.relative(path.dirname(e.dir), e.tfvars) + (e.backendConf ? ' + ' + path.basename(e.backendConf) : '')
      : e.workspace ? `workspace ${e.workspace}` : 'plan as is';
    const item = (e: Env): Pick => ({ label: e.name, description: describe(e), env: e });
    const tfvars = envs.filter((e) => e.tfvars);
    const plain = envs.filter((e) => !e.tfvars);
    const items: Pick[] = [
      ...(tfvars.length && plain.length ? [{ label: 'Environments', kind: vscode.QuickPickItemKind.Separator }] : []),
      ...tfvars.map(item),
      ...(tfvars.length && plain.length ? [{ label: 'Terraform folders', kind: vscode.QuickPickItemKind.Separator }] : []),
      ...plain.map(item),
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      ...(plainRoots.length ? [{ label: '$(layers) Find workspaces…', description: 'terraform workspace list', id: 'workspaces' as const }] : []),
      { label: '$(folder) Change environments folder…', description: envSource, id: 'folder' },
    ];
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Environment or Terraform folder to plan', matchOnDescription: true });
    if (!pick) return undefined;
    if (!pick.env) {
      await (pick.id === 'workspaces' ? findWorkspaces() : setEnvFolder());
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
    let env: Env | undefined;
    try {
      await discover();
      env = envName ? envs.find((e) => e.name === envName) : store.env;
      if (!env) env = await pickEnv();
      if (!env) return store.setRunning(false);
      store.env = env;
      store.runEnv = env.name;
      store.touch();
      await ctx.workspaceState.update(ENV_KEY, env.name);
      const targets = compactTargets(picked);
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Plan Lens: terraform plan ${env.name}${targets.length ? ` (${targets.length} target${targets.length > 1 ? 's' : ''})` : ''}`, cancellable: true },
        (_p, token) => {
          token.onCancellationRequested(() => void cancelRun());
          return runner.runPlan(env!, cts.token, targets);
        },
      );
      const plan = parsePlan(result.json, { env: env.name, source: 'run', loadedAt: Date.now() });
      if (targets.length) plan.targets = targets;
      await runner.discard(saved);
      saved = result.saved;
      store.running = false;
      await store.setPlan(plan, env.root);
      if (refactorCheck?.env === env.name) reportRefactor(refactorCheck, plan.changes.filter((c) => c.action === 'destroy').length);
    } catch (e) {
      refactorCheck = undefined;
      failed(e, env ? { env, targets: picked } : undefined);
    } finally {
      if (cancel === cts) cancel = undefined;
      cts.dispose();
    }
  }

  /** After a plan failed on the state lock: says who holds it, and force-unlocks then plans again if the user confirms. */
  async function unlockAndPlan(lock: StateLock, at: { env: Env; targets: string[] }): Promise<void> {
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
        () => runner.forceUnlock(at.env, lock.id, cts.token),
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
      const b = await vscode.window.showInformationMessage(
        'Plan Lens: Apply is off. Turn it on for this workspace? You still confirm each apply (and type the environment name when it destroys or replaces).',
        { modal: true }, 'Turn on for this workspace');
      if (b !== 'Turn on for this workspace') return;
      const target = vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
      await config().update('allowApply', true, target);
      // Straight on to the apply's own confirmation.
    }
    const plan = store.plan;
    const s = saved;
    if (!plan || !s || plan.env !== s.env.name) {
      return void vscode.window.showInformationMessage('Plan Lens: run a plan from here first; only a plan run by Plan Lens can be applied.');
    }
    const n = (a: string) => plan.changes.filter((c) => c.action === a).length;
    const destroys = n('destroy') + n('forget');
    const imports = plan.changes.filter((c) => c.importing !== undefined).length;
    const summary = [`${imports} to import`, `${n('create')} to create`, `${n('update')} to update`, `${n('replace')} to replace`, `${destroys} to destroy`].filter((t) => !t.startsWith('0 ')).join(', ');
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

  /**
   * Refactor autopilot: appends the picked moves to moved.tf in the plan's root (one undoable edit, saved, shown beside),
   * then re-plans when asked so the destroys are seen gone. Only moves the store computed are written, whatever the
   * webview sends.
   */
  async function writeMoves(ids: string[], replan: boolean): Promise<void> {
    const plan = store.plan;
    const root = store.root;
    if (!plan || !root || store.running) return;
    const picked = store.moves.filter((m) => ids.includes(m.id));
    if (!picked.length) return;
    // A from already in a moved block of the root (written earlier, not re-planned yet) is not written twice.
    const done = new Set<string>();
    for (const f of (await readdir(root).catch(() => [] as string[])).filter((f) => f.endsWith('.tf'))) {
      for (const from of movedFroms(await readFile(path.join(root, f), 'utf8').catch(() => ''))) done.add(from);
    }
    const fresh = picked.filter((m) => !done.has(m.from));
    const file = vscode.Uri.file(path.join(root, 'moved.tf'));
    if (fresh.length) {
      const kept = fresh.reduce((n, m) => n + m.covers.length, 0);
      const label = plan.env || path.basename(plan.source);
      const header = `Plan Lens · ${label} · ${new Date().toISOString().slice(0, 10)}: ${kept} destroy${kept > 1 ? 's' : ''} kept as move${kept > 1 ? 's' : ''}`;
      const exists = existsSync(file.fsPath);
      const doc = exists ? await vscode.workspace.openTextDocument(file) : undefined;
      const before = doc?.getText() ?? '';
      const gap = !before ? '' : before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
      const edit = new vscode.WorkspaceEdit();
      if (!exists) edit.createFile(file, { ignoreIfExists: true });
      const end = doc ? doc.lineAt(doc.lineCount - 1).range.end : new vscode.Position(0, 0);
      edit.insert(file, end, gap + movedHcl(fresh, header));
      if (!(await vscode.workspace.applyEdit(edit))) return void vscode.window.showErrorMessage('Plan Lens: could not write moved.tf.');
      const saved = await vscode.workspace.openTextDocument(file);
      await saved.save();
      // Shown beside, the new blocks selected: what was written is plain to see (and Ctrl+Z takes it back).
      const first = end.line + gap.split('\n').length - 1;
      await vscode.window.showTextDocument(saved, { viewColumn: vscode.ViewColumn.Beside, preview: true, preserveFocus: replan, selection: new vscode.Range(first, 0, saved.lineCount - 1, 0) });
    }
    const skipped = picked.length - fresh.length;
    if (!replan || !plan.env) {
      const what = fresh.length ? `${fresh.length} moved block${fresh.length > 1 ? 's' : ''} written to moved.tf` : 'Those moves are already in moved.tf';
      void vscode.window.showInformationMessage(`Plan Lens: ${what}${skipped && fresh.length ? ` (${skipped} already there)` : ''}. Plan again to see the destroys gone.`);
      return;
    }
    refactorCheck = { env: plan.env, destroys: plan.changes.filter((c) => c.action === 'destroy').length, kept: picked.reduce((n, m) => n + m.covers.length, 0) };
    // A full plan: targets name the old addresses.
    void runPlan(plan.env);
  }

  /** After Write & re-plan: how many destroys the moves kept, and a way to look when some did not take. */
  function reportRefactor(check: { destroys: number; kept: number }, destroys: number): void {
    refactorCheck = undefined;
    const gone = check.destroys - destroys;
    if (gone >= check.kept) {
      void vscode.window.showInformationMessage(`Plan Lens: refactor kept ${gone} object${gone > 1 ? 's' : ''}: destroys ${check.destroys} → ${destroys}.`);
      return;
    }
    void vscode.window.showWarningMessage(
      `Plan Lens: destroys ${check.destroys} → ${destroys}, ${check.kept - Math.max(gone, 0)} of the moves did not keep their object (terraform may still replace it, or the pair was wrong). Check moved.tf.`,
      'Open moved.tf').then((b) => b && store.root && void vscode.window.showTextDocument(vscode.Uri.file(path.join(store.root, 'moved.tf'))));
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
          throw new RunError(`Could not read this plan file with terraform show (${(e as Error).message}). Run a plan here, or load its JSON (terraform show -json).`);
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
          const others = [...new Set(envs.map((e) => e.root))].filter((r) => r !== root);
          const pick = others.length
            ? await vscode.window.showQuickPick([...others.map((r) => ({ label: rootName(r), root: r })), { label: '$(folder-opened) Other folder…', root: '' }], { placeHolder: 'Terraform root the plan was made for' })
            : { root: '' };
          let dir = pick?.root;
          if (pick && !dir) [dir] = ((await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Use as Terraform root', defaultUri: vscode.Uri.file(root) })) ?? []).map((u) => u.fsPath);
          if (dir) await store.setPlan(plan, dir);
        }
      }
    } catch (e) {
      failed(e);
    }
  }

  function failed(e: unknown, planned?: { env: Env; targets: string[] }): void {
    const err = e instanceof RunError ? e : new RunError((e as Error)?.message ?? String(e));
    store.setRunning(false, err.cancelled ? undefined : err.message);
    if (err.cancelled) return;
    const lock = planned && err.lock;
    const login = err.login ? `Run ${err.login.command}` : undefined;
    const actions = [...(err.untrusted ? ['Manage Workspace Trust'] : []), ...(lock ? ['Force unlock…'] : []), ...(login ? [login] : []), 'Open log'];
    void vscode.window.showErrorMessage(`Plan Lens: ${err.message}`, ...actions).then((b) => {
      if (b === 'Force unlock…' && lock) void unlockAndPlan(lock, planned!);
      if (b === 'Open log') out.show(true);
      if (b === 'Manage Workspace Trust') void vscode.commands.executeCommand('workbench.trust.manage');
      if (b && b === login) {
        // Typed in a terminal, not run for the user: logins are interactive (browser, MFA).
        const t = vscode.window.createTerminal({ name: `${err.login!.cloud} login`, cwd: store.root });
        t.show();
        t.sendText(err.login!.command);
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
  const settingsPanel = new SettingsPanel(ctx, () => envSource, { envFolder: () => void setEnvFolder(), findWorkspaces: () => void findWorkspaces() });
  ctx.subscriptions.push(settingsPanel);
  const view = new PlanViewProvider(ctx, store, out, viewInfo, (m: ViewMessage) => {
    switch (m.type) {
      case 'run': return void runPlan(m.env, Array.isArray(m.targets) ? m.targets.filter((t) => typeof t === 'string') : []);
      case 'load': return void loadPlan();
      case 'apply': return void apply();
      case 'envFolder': return void setEnvFolder();
      case 'settings': return settingsPanel.show();
      case 'setting': {
        // Only what the settings page lists, with a value of its kind; apply stays a per-workspace choice.
        const ok = validSetting(m.key, m.value);
        if (!ok) return;
        const target = ok.def.workspace && vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
        return void config().update(ok.def.key, ok.def.type === 'string' && !ok.value ? undefined : ok.value, target);
      }
      case 'findWorkspaces': return void findWorkspaces();
      case 'cancel': return void cancelRun();
      case 'clear': return void clearPlan();
      case 'log': return out.show(true);
      case 'pickEnv': return void pickEnv();
      case 'open': return void openAddress(m.address);
      case 'moves': return void writeMoves(Array.isArray(m.ids) ? m.ids.filter((i) => typeof i === 'string') : [], !!m.replan);
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
    vscode.commands.registerCommand('planLens.findWorkspaces', () => findWorkspaces()),
    vscode.commands.registerCommand('planLens.openSettingsPage', () => settingsPanel.show()),
    vscode.commands.registerCommand('planLens.writeMoves', (ids: string[], replan?: boolean) => writeMoves(Array.isArray(ids) ? ids : [], !!replan)),
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
  registerMoveActions(ctx, store);
  ctx.subscriptions.push(new EditPreview(store, runner));
  ctx.subscriptions.push(new InlineValues(store, new Evaluator(out, ctx.globalStorageUri.fsPath, binary), (s) => out.appendLine(s)));

  // The Plan Lens sidebar (and its activity bar icon) only shows when the workspace has Terraform files.
  const updateHasTerraform = async () => {
    const tf = await vscode.workspace.findFiles('**/*.tf', '**/{.terraform,node_modules}/**', 1);
    await vscode.commands.executeCommand('setContext', 'planLens.hasTerraform', tf.length > 0);
  };
  const watcher = vscode.workspace.createFileSystemWatcher('**/*.tf', false, true, false);
  ctx.subscriptions.push(
    watcher,
    watcher.onDidCreate(() => (rootsCache = undefined, void updateHasTerraform())),
    watcher.onDidDelete(() => (rootsCache = undefined, void updateHasTerraform())),
    vscode.workspace.onDidSaveTextDocument((d) => d.fileName.endsWith('.tf') && (rootsCache = undefined)),
    vscode.workspace.onDidChangeWorkspaceFolders(() => (rootsCache = undefined, void updateHasTerraform(), void discover())),
  );
  void updateHasTerraform();
  void discover();
}

export function deactivate(): void {}
