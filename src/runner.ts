import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { Env, dataDir, isAzureAuthError, lastErrorLine, planArgs } from './model/envs';

export class RunError extends Error {
  constructor(message: string, readonly azureAuth: boolean, readonly cancelled = false) {
    super(message);
  }
}

/** Runs terraform init / plan / show. Never anything that writes infrastructure or state. */
export class Runner {
  constructor(
    private readonly out: vscode.OutputChannel,
    private readonly globalStorage: string,
    private readonly tfPath: () => string,
  ) {}

  async runPlan(root: string, env: Env, token: vscode.CancellationToken): Promise<unknown> {
    const tfData = dataDir(this.globalStorage, root, env.name);
    await mkdir(tfData, { recursive: true });
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'plan-lens-'));
    const planFile = path.join(tmp, 'plan.bin');
    const args = planArgs(env, planFile);
    this.out.appendLine(`── Plan ${env.name} · ${new Date().toLocaleTimeString()} ──`);
    try {
      await this.exec(root, args.init, tfData, token);
      await this.exec(root, args.plan, tfData, token);
      return JSON.parse(await this.exec(root, args.show, tfData, token, true));
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
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

  private exec(cwd: string, args: string[], tfData: string | undefined, token: vscode.CancellationToken, quiet = false): Promise<string> {
    this.out.appendLine(`$ terraform ${args.join(' ')}`);
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
        if (token.isCancellationRequested) return reject(new RunError('Plan cancelled', false, true));
        if (code === 0) return resolve(stdout);
        const text = stderr || stdout;
        reject(new RunError(lastErrorLine(text) || `terraform ${args[0]} failed (${code})`, isAzureAuthError(text)));
      });
    });
  }
}
