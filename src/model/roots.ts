// Terraform roots of a workspace that has no environments/ convention: every folder with .tf files that is not
// a module of another folder. Each root plans as-is (terraform.tfvars and *.auto.tfvars load by themselves),
// once per workspace when it has some.
import * as path from 'node:path';
import { Env } from './envs';
import { scanBlocks } from './hclScanner';

const LOCAL_SOURCE = /\bsource\s*=\s*"(\.\.?\/[^"]*)"/g;

/** Absolute folders of the local modules (`source = "./…"` or `"../…"`) the text calls. */
export function localModuleDirs(dir: string, text: string): string[] {
  return [...text.matchAll(LOCAL_SOURCE)].map((m) => path.resolve(dir, m[1]));
}

/** Folders holding .tf files, minus the ones another folder uses as a local module and any under a `modules` folder. */
export function terraformRoots(files: { path: string; text: string }[]): string[] {
  const dirs = new Set<string>();
  const modules = new Set<string>();
  for (const f of files) {
    const dir = path.dirname(f.path);
    dirs.add(dir);
    for (const m of localModuleDirs(dir, f.text)) modules.add(m);
  }
  return [...dirs].filter((d) => !modules.has(d) && !d.split(/[\\/]/).includes('modules')).sort();
}

/** The plain env of a root, then one per workspace (`infra:prod`); `default` is the plain one. */
export function rootEnvs(root: string, name: string, workspaces: string[]): Env[] {
  const plain: Env = { name, root, dir: root };
  const named = workspaces.filter((ws) => ws !== 'default').sort();
  return [plain, ...named.map((workspace) => ({ ...plain, name: `${name}:${workspace}`, workspace }))];
}

/** Workspace names from `terraform workspace list` (the current one is starred). */
export function parseWorkspaceList(stdout: string): string[] {
  return stdout.split(/\r?\n/).map((l) => l.replace(/^\*/, '').trim()).filter(Boolean);
}

/** With envs from several roots, names get their root in front (`infra/QUAL`) so they stay unique. */
export function qualifyNames(envs: Env[], rootName: (root: string) => string): Env[] {
  if (new Set(envs.map((e) => e.root)).size < 2) return envs;
  return envs.map((e) => ({ ...e, name: `${rootName(e.root)}/${e.name}` }));
}

/**
 * The calls of the module in `moduleDir` from the root's own files (`module "x" { source = "./modules/net" }`): their
 * names, and whether they make several instances (for_each / count).
 */
export function moduleCallsOf(rootDir: string, files: { path: string; text: string }[], moduleDir: string): { name: string; multi: boolean }[] {
  const calls: { name: string; multi: boolean }[] = [];
  for (const f of files) {
    if (path.dirname(f.path) !== rootDir) continue;
    const lines = f.text.split(/\r?\n/);
    for (const b of scanBlocks(f.text)) {
      if (b.kind !== 'module') continue;
      const body = lines.slice(b.startLine, b.endLine + 1).join('\n');
      const src = /\bsource\s*=\s*"(\.\.?\/[^"]*)"/.exec(body)?.[1];
      if (!src || path.resolve(rootDir, src) !== path.resolve(moduleDir)) continue;
      calls.push({ name: b.name, multi: /^\s*(for_each|count)\s*=/m.test(body) });
    }
  }
  return calls;
}
