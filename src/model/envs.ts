import { createHash } from 'node:crypto';
import * as path from 'node:path';

export interface Env {
  /** Folder below `environments/` (or below the root): `QUAL`, `PROD/dev`. */
  name: string;
  /** Absolute fs paths, kept verbatim (a `%20` in a folder name is a real `%20`). */
  dir: string;
  tfvars: string;
  backendConf?: string;
}

export function envsFromFiles(root: string, tfvarsFiles: string[], exists: (p: string) => boolean): Env[] {
  const base = path.join(root, 'environments');
  return tfvarsFiles
    .map((tfvars) => {
      const dir = path.dirname(tfvars);
      const rel = path.relative(base, dir);
      const name = (rel && !rel.startsWith('..') ? rel : path.relative(root, dir)).split(path.sep).join('/');
      const backend = path.join(dir, 'backend.conf');
      return { name: name || '.', dir, tfvars, ...(exists(backend) ? { backendConf: backend } : {}) };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The parent of the `environments` folder containing the file, else the file's own folder. */
export function findRoot(tfvarsFile: string): string {
  const parts = path.dirname(tfvarsFile).split(path.sep);
  const i = parts.lastIndexOf('environments');
  return i > 0 ? parts.slice(0, i).join(path.sep) : path.dirname(tfvarsFile);
}

export function planArgs(env: Env, out: string): { init: string[]; plan: string[]; show: string[] } {
  return {
    init: ['init', '-input=false', '-reconfigure', ...(env.backendConf ? [`-backend-config=${env.backendConf}`] : [])],
    plan: ['plan', '-input=false', `-var-file=${env.tfvars}`, `-out=${out}`],
    show: ['show', '-json', out],
  };
}

export function dataDir(globalStorage: string, root: string, env: string): string {
  const hash = createHash('sha1').update(root).digest('hex').slice(0, 12);
  return path.join(globalStorage, hash, env.replace(/[\\/]/g, '_'));
}

export function isAzureAuthError(text: string): boolean {
  return /az login|AADSTS\d+/i.test(text);
}

const ANSI = /\x1b\[[0-9;]*m/g;

export function lastErrorLine(stderr: string): string {
  const lines = stderr.replace(ANSI, '').split(/\r?\n/).map((l) => l.replace(/^[│╷╵]\s?/, '').trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i].startsWith('Error:')) return lines[i];
  return lines[lines.length - 1] ?? '';
}
