import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { targetArgs } from './targets';

export interface Env {
  /** Folder below `environments/` (or below the root): `QUAL`, `PROD/dev`; a root's own path for a plain root (`infra`, `infra:prod`). */
  name: string;
  /** Absolute fs paths, kept verbatim (a `%20` in a folder name is a real `%20`). `root` is the Terraform root the env plans. */
  root: string;
  dir: string;
  /** Unset for a plain root: terraform loads its terraform.tfvars and *.auto.tfvars itself. */
  tfvars?: string;
  backendConf?: string;
  /** Terraform workspace, selected with TF_WORKSPACE; unset is the default one. */
  workspace?: string;
}

/**
 * One env per tfvars file, named from its folder below `base` (default `<root>/environments`).
 * A tfvars not called terraform.tfvars adds its stem: `environments/qual.tfvars` is `qual`. `*.auto.tfvars` are not envs.
 */
export function envsFromFiles(root: string, tfvarsFiles: string[], exists: (p: string) => boolean, base = path.join(root, 'environments')): Env[] {
  return tfvarsFiles
    .filter((f) => !f.endsWith('.auto.tfvars'))
    .map((tfvars) => {
      const dir = path.dirname(tfvars);
      const rel = path.relative(base, dir);
      const parts = (rel.startsWith('..') ? path.relative(root, dir) : rel).split(path.sep).filter(Boolean);
      const file = path.basename(tfvars);
      const stem = file === 'terraform.tfvars' ? '' : file.replace(/\.tfvars$/, '');
      if (stem) parts.push(stem);
      const name = parts.join('/');
      // qual.tfvars pairs with qual.backend.conf when there is one, else the folder's backend.conf.
      const backend = [stem && path.join(dir, `${stem}.backend.conf`), path.join(dir, 'backend.conf')].find((b) => b && exists(b));
      return { name: name || '.', root, dir, tfvars, ...(backend ? { backendConf: backend } : {}) };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The parent of the `environments` folder containing the file, else the file's own folder. */
export function findRoot(tfvarsFile: string): string {
  const parts = path.dirname(tfvarsFile).split(path.sep);
  const i = parts.lastIndexOf('environments');
  return i > 0 ? parts.slice(0, i).join(path.sep) : path.dirname(tfvarsFile);
}

export function planArgs(env: Env, out: string, targets: string[] = []): { init: string[]; plan: string[]; show: string[] } {
  return {
    init: ['init', '-input=false', '-reconfigure', ...(env.backendConf ? [`-backend-config=${env.backendConf}`] : [])],
    plan: ['plan', '-input=false', ...(env.tfvars ? [`-var-file=${env.tfvars}`] : []), `-out=${out}`, ...targetArgs(targets)],
    show: ['show', '-json', out],
  };
}

/** Edit preview: a quick plan of a few blocks — no refresh, no state lock (read only), nothing saved to apply. */
export function previewArgs(env: Env, out: string, targets: string[]): string[] {
  return ['plan', '-input=false', '-refresh=false', '-lock=false', ...(env.tfvars ? [`-var-file=${env.tfvars}`] : []), `-out=${out}`, ...targetArgs(targets)];
}

/**
 * The extra -target options terraform asks for when targeting leaves out objects that moved blocks move (moves not
 * applied yet): `-target="module.inst[\"i0\"]"` in its message.
 */
export function movedTargets(text: string): string[] {
  if (!/Moved resource instances excluded by targeting/.test(text)) return [];
  return [...text.matchAll(/-target="((?:[^"\\]|\\.)*)"/g)].map((m) => m[1].replace(/\\(.)/g, '$1'));
}

/** Applies exactly the saved plan the user reviewed (no prompt; terraform refuses it if the state moved since). */
export function applyArgs(planFile: string): string[] {
  return ['apply', '-input=false', planFile];
}

/** Terraform root for an environments folder: the folder itself if it holds .tf files, else its parent. */
export function rootForEnvFolder(envFolder: string, hasTf: (dir: string) => boolean): string {
  return hasTf(envFolder) ? envFolder : path.dirname(envFolder);
}

export function dataDir(globalStorage: string, root: string, env: string): string {
  const hash = createHash('sha1').update(root).digest('hex').slice(0, 12);
  return path.join(globalStorage, hash, env.replace(/[\\/:]/g, '_'));
}

/** Environment variables a run of the env needs on top of the user's. */
export function runEnvVars(env: Env): Record<string, string> {
  return env.workspace ? { TF_WORKSPACE: env.workspace } : {};
}

/** The binary to run: the one set in planLens.terraformPath, else terraform, else OpenTofu's tofu when only it is installed. */
export function pickBinary(setting: string | undefined, onPath: (name: string) => boolean): string {
  if (setting) return setting;
  return !onPath('terraform') && onPath('tofu') ? 'tofu' : 'terraform';
}

/** A cloud login a failed run needs, and the command that does it. */
export interface CloudLogin {
  cloud: 'Azure' | 'AWS' | 'Google Cloud';
  command: string;
}

/** The cloud login a run's error text asks for, when it is an expired or missing login. */
export function cloudLogin(text: string): CloudLogin | undefined {
  if (/az login|AADSTS\d+/i.test(text)) return { cloud: 'Azure', command: 'az login' };
  if (/sso session .*(expired|invalid)|aws sso login/i.test(text)) return { cloud: 'AWS', command: 'aws sso login' };
  if (/no valid credential sources|ExpiredToken|InvalidClientTokenId|failed to refresh cached credentials/i.test(text)) return { cloud: 'AWS', command: 'aws configure' };
  if (/could not find default credentials|application-default login|oauth2: cannot fetch token|invalid_grant|reauthentication/i.test(text)) {
    return { cloud: 'Google Cloud', command: 'gcloud auth application-default login' };
  }
  return undefined;
}

const ANSI = /\x1b\[[0-9;]*m/g;

/** Who holds the remote state lock, from terraform's "Error acquiring the state lock" output. */
export interface StateLock {
  id: string;
  who?: string;
  operation?: string;
  created?: string;
}

export function stateLock(text: string): StateLock | undefined {
  const plain = text.replace(ANSI, '');
  if (!/Error acquiring the state lock/i.test(plain)) return undefined;
  const field = (name: string) => plain.match(new RegExp(`^[│\\s]*${name}:[ \\t]*(.+)$`, 'm'))?.[1].trim() || undefined;
  const id = field('ID');
  if (!id) return undefined;
  return { id, who: field('Who'), operation: field('Operation')?.replace(/^OperationType/, ''), created: field('Created') };
}

/** terraform force-unlock, without its yes/no prompt (the user confirms in VS Code). */
export function unlockArgs(id: string): string[] {
  return ['force-unlock', '-force', id];
}

export function lastErrorLine(stderr: string): string {
  const lines = stderr.replace(ANSI, '').split(/\r?\n/).map((l) => l.replace(/^[│╷╵]\s?/, '').trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i].startsWith('Error:')) return lines[i];
  return lines[lines.length - 1] ?? '';
}
