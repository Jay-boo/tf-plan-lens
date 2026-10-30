import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { PlanLog } from './log';
import { Env, StateLock, applyArgs, dataDir, isAzureAuthError, lastErrorLine, planArgs, stateLock, unlockArgs } from './model/envs';

export class RunError extends Error {
  /** Set when terraform could not take the remote state lock (another run holds it, or a killed one left it). */
  lock?: StateLock;

  constructor(message: string, readonly azureAuth: boolean, readonly cancelled = false) {
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

  async runPlan(root: string, env: Env, token: vscode.CancellationToken, targets: string[] = []): Promise<{ json: unknown; saved: SavedPlan }> {
    const tfData = dataDir(this.globalStorage, root, env.name);
    await mkdir(tfData, { recursive: true });
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'plan-lens-'));
    const planFile = path.join(tmp, 'plan.bin');
    const args = planArgs(env, planFile, targets);
    this.out.heading(`── ${targets.length ? `Targeted plan (${targets.length})` : 'Plan'} ${env.name} · ${new Date().toLocaleTimeString()} ──`);
    try {
      await this.exec(root, args.init, tfData, token);
      await this.exec(root, args.plan, tfData, token);
      const json = JSON.parse(await this.exec(root, args.show, tfData, token, true));
      return { json, saved: { root, env, file: planFile } };
    } catch (e) {
      await rm(tmp, { recursive: true, force: true });
      throw e;
    }
  }

  /** terraform apply of the saved plan, with the init the plan ran under. */
  async apply(saved: SavedPlan, token: vscode.CancellationToken): Promise<void> {
    this.out.heading(`── Apply ${saved.env.name} · ${new Date().toLocaleTimeString()} ──`);
    await this.exec(saved.root, applyArgs(saved.file), dataDir(this.globalStorage, saved.root, saved.env.name), token, false, 'Apply');
  }

  /** terraform force-unlock of the env's remote state, under the init its plan ran with. */
  async forceUnlock(root: string, env: Env, id: string, token: vscode.CancellationToken): Promise<void> {
    this.out.heading(`── Unlock ${env.name} · ${new Date().toLocaleTimeString()} ──`);
    await this.exec(root, unlockArgs(id), dataDir(this.globalStorage, root, env.name), token, false, 'Unlock');
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

  private exec(cwd: string, args: string[], tfData: string | undefined, token: vscode.CancellationToken, quiet = false, what = 'Plan'): Promise<string> {
    this.out.command(`terraform ${args.join(' ')}`);
    return new Promise((resolve, reject) => {
      const env: NodeJS.ProcessEnv = { ...process.env, TF_IN_AUTOMATION: '1', TF_CLI_ARGS: '' };
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
        reject(new RunError(`Could not start terraform (${this.tfPath()}): ${e.message}`, false));
      });
      child.on('close', (code) => {
        sub.dispose();
        if (token.isCancellationRequested) return reject(new RunError(`${what} cancelled`, false, true));
        if (code === 0) return resolve(stdout);
        const text = stderr || stdout;
        const err = new RunError(lastErrorLine(text) || `terraform ${args[0]} failed (${code})`, isAzureAuthError(text));
        err.lock = stateLock(text);
        reject(err);
      });
    });
  }
}
