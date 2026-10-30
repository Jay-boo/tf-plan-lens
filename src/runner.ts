import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { PlanLog } from './log';
import { Env, StateLock, applyArgs, dataDir, movedTargets, previewArgs, CloudLogin, cloudLogin, lastErrorLine, planArgs, runEnvVars, stateLock, unlockArgs } from './model/envs';
import { parseWorkspaceList } from './model/roots';

export class RunError extends Error {
  /** Set when terraform could not take the remote state lock (another run holds it, or a killed one left it). */
  lock?: StateLock;
  /** Set when nothing ran because the workspace is not trusted. */
  untrusted?: boolean;
  /** terraform's whole error output. */
  detail?: string;

  constructor(message: string, readonly login?: CloudLogin, readonly cancelled = false) {
    super(message);
  }
}

/** A plan run's saved plan file, kept until it is applied or replaced (it is what Apply applies). */
export interface SavedPlan {
  root: string;
  env: Env;
  file: string;
}

/** Runs terraform init / plan / show, and apply of a saved plan (only when the user asks, see extension.ts). */
export class Runner {
  constructor(
    private readonly out: PlanLog,
    private readonly globalStorage: string,
    private readonly tfPath: () => string,
  ) {}

  async runPlan(env: Env, token: vscode.CancellationToken, targets: string[] = []): Promise<{ json: unknown; saved: SavedPlan }> {
    const root = env.root;
    const tfData = dataDir(this.globalStorage, root, env.name);
    await mkdir(tfData, { recursive: true });
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'plan-lens-'));
    const planFile = path.join(tmp, 'plan.bin');
    const args = planArgs(env, planFile, targets);
    this.out.heading(`── ${targets.length ? `Targeted plan (${targets.length})` : 'Plan'} ${env.name} · ${new Date().toLocaleTimeString()} ──`);
    try {
      const vars = runEnvVars(env);
      await this.exec(root, args.init, tfData, token, false, 'Plan', vars);
      await this.exec(root, args.plan, tfData, token, false, 'Plan', vars);
      const json = JSON.parse(await this.exec(root, args.show, tfData, token, true, 'Plan', vars));
      return { json, saved: { root, env, file: planFile } };
    } catch (e) {
      await rm(tmp, { recursive: true, force: true });
      throw e;
    }
  }

  /**
   * Edit preview: plans only `targets`, read only, under the init of the env's last plan (never an init of its own:
   * no surprise logins or downloads). Undefined when the env has not been planned here yet.
   */
  async preview(env: Env, targets: string[], token: vscode.CancellationToken): Promise<unknown | undefined> {
    const tfData = dataDir(this.globalStorage, env.root, env.name);
    // Planned here before (the caller checks the plan shown is this env's): its init is there to reuse.
    if (!existsSync(tfData)) return undefined;
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'plan-lens-preview-'));
    const out = path.join(tmp, 'plan.bin');
    try {
      const vars = runEnvVars(env);
      try {
        await this.exec(env.root, previewArgs(env, out, targets), tfData, token, true, 'Preview', vars);
      } catch (e) {
        // Moved blocks not applied yet: terraform wants their objects targeted too, and says which.
        const more = movedTargets((e as RunError).detail ?? '');
        if (!more.length) throw e;
        await this.exec(env.root, previewArgs(env, out, [...targets, ...more]), tfData, token, true, 'Preview', vars);
      }
      return JSON.parse(await this.exec(env.root, ['show', '-json', out], tfData, token, true, 'Preview', vars));
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }

  /** terraform apply of the saved plan, with the init the plan ran under. */
  async apply(saved: SavedPlan, token: vscode.CancellationToken): Promise<void> {
    this.out.heading(`── Apply ${saved.env.name} · ${new Date().toLocaleTimeString()} ──`);
    await this.exec(saved.root, applyArgs(saved.file), dataDir(this.globalStorage, saved.root, saved.env.name), token, false, 'Apply', runEnvVars(saved.env));
  }

  /** terraform force-unlock of the env's remote state, under the init its plan ran with. */
  async forceUnlock(env: Env, id: string, token: vscode.CancellationToken): Promise<void> {
    this.out.heading(`── Unlock ${env.name} · ${new Date().toLocaleTimeString()} ──`);
    await this.exec(env.root, unlockArgs(id), dataDir(this.globalStorage, env.root, env.name), token, false, 'Unlock', runEnvVars(env));
  }

  /** The root's workspaces, from terraform workspace list after an init of its default workspace (with its backend.conf). */
  async listWorkspaces(env: Env, token: vscode.CancellationToken): Promise<string[]> {
    const plain: Env = { ...env, workspace: undefined };
    const tfData = dataDir(this.globalStorage, plain.root, plain.name);
    await mkdir(tfData, { recursive: true });
    this.out.heading(`── Workspaces of ${plain.name} · ${new Date().toLocaleTimeString()} ──`);
    await this.exec(plain.root, planArgs(plain, '').init, tfData, token, false, 'Listing workspaces');
    return parseWorkspaceList(await this.exec(plain.root, ['workspace', 'list'], tfData, token, false, 'Listing workspaces'));
  }

  /** Deletes a saved plan file (it can hold secrets in clear). */
  async discard(saved: SavedPlan | undefined): Promise<void> {
    if (saved) await rm(path.dirname(saved.file), { recursive: true, force: true });
  }

  /** Converts a binary plan with the root's providers (needs a prior init in the user's own .terraform). */
  async showJson(root: string, planFile: string): Promise<unknown> {
    const src = new vscode.CancellationTokenSource();
    try {
      return JSON.parse(await this.exec(root, ['show', '-json', planFile], undefined, src.token, true));
    } finally {
      src.dispose();
    }
  }

  private exec(cwd: string, args: string[], tfData: string | undefined, token: vscode.CancellationToken, quiet = false, what = 'Plan', vars: Record<string, string> = {}): Promise<string> {
    this.out.command(`${path.basename(this.tfPath())} ${args.join(' ')}`);
    return new Promise((resolve, reject) => {
      // terraform init and plan run the workspace's providers and modules: only in a workspace the user trusts.
      if (!vscode.workspace.isTrusted) {
        const err = new RunError('This workspace is not trusted. Terraform runs code from it (providers, modules), so Plan Lens only runs it in trusted workspaces. Loading a plan JSON still works.');
        err.untrusted = true;
        return reject(err);
      }
      // TF_WORKSPACE is the env's, never one left in the user's shell: the env picked is the one planned.
      const env: NodeJS.ProcessEnv = { ...process.env, TF_IN_AUTOMATION: '1', TF_CLI_ARGS: '', TF_WORKSPACE: undefined, ...vars };
      if (tfData) env.TF_DATA_DIR = tfData;
      const child = spawn(this.tfPath(), args, { cwd, env, shell: false });
      let stdout = '';
      let stderr = '';
      const sub = token.onCancellationRequested(() => child.kill());
      // Decode as a stream so multi-byte characters split across chunks (é in a tag) stay intact.
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (s: string) => {
        stdout += s;
        if (!quiet) this.out.append(s);
      });
      child.stderr.on('data', (s: string) => {
        stderr += s;
        this.out.append(s);
      });
      child.on('error', (e) => {
        sub.dispose();
        reject(new RunError(`Could not start ${this.tfPath()} (${e.message}). Install Terraform or OpenTofu, or set planLens.terraformPath.`));
      });
      child.on('close', (code) => {
        sub.dispose();
        if (token.isCancellationRequested) return reject(new RunError(`${what} cancelled`, undefined, true));
        if (code === 0) return resolve(stdout);
        const text = stderr || stdout;
        const err = new RunError(lastErrorLine(text) || `terraform ${args[0]} failed (${code})`, cloudLogin(text));
        err.lock = stateLock(text);
        err.detail = text;
        reject(err);
      });
    });
  }
}
