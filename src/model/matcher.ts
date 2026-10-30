import * as path from 'node:path';
import { Block } from './hclScanner';
import { Action, Change, Plan, SEVERITY, worst } from './types';

export interface BlockMark {
  block: Block;
  changes: Change[];
  action: Action;
  hint: string;
}

export interface FileBlocks {
  /** Posix, relative to the Terraform root. */
  path: string;
  blocks: Block[];
}

/** Folder of a module path relative to the root ('' for the root module), undefined for non-local modules. */
export function moduleDirOf(plan: Plan, modulePath: string[]): string | undefined {
  if (modulePath.length === 0) return '';
  return plan.moduleDirs[modulePath.join('.')];
}

const key = (dir: string, mode: string, type: string, name: string) => `${dir}|${mode}|${type}|${name}`;
const dirOf = (file: string) => {
  const d = path.posix.dirname(file);
  return d === '.' ? '' : d;
};

export function matchPlan(plan: Plan, files: FileBlocks[]): { byFile: Map<string, BlockMark[]>; orphans: Change[] } {
  const index = new Map<string, Change[]>();
  const unmatched = new Set<Change>();
  for (const c of plan.changes) {
    const dir = moduleDirOf(plan, c.modulePath);
    unmatched.add(c);
    if (dir === undefined) continue;
    const k = key(dir, c.mode, c.type, c.name);
    (index.get(k) ?? index.set(k, []).get(k)!).push(c);
  }
  // Every module path that lives in a folder (a folder can be called several times, from several places).
  const pathsByDir = new Map<string, string[][]>([['', [[]]]]);
  for (const [p, d] of Object.entries(plan.moduleDirs)) {
    (pathsByDir.get(d) ?? pathsByDir.set(d, []).get(d)!).push(p.split('.'));
  }

  const byFile = new Map<string, BlockMark[]>();
  for (const f of files) {
    const dir = dirOf(f.path);
    const marks: BlockMark[] = [];
    for (const b of f.blocks) {
      let changes: Change[];
      if (b.kind === 'module') {
        const prefixes = (pathsByDir.get(dir) ?? []).map((p) => [...p, b.name]);
        changes = plan.changes.filter((c) => prefixes.some((p) => p.every((s, i) => c.modulePath[i] === s)));
      } else {
        changes = index.get(key(dir, b.kind === 'data' ? 'data' : 'managed', b.type!, b.name)) ?? [];
        changes.forEach((c) => unmatched.delete(c));
      }
      if (!changes.length) continue;
      const mark: BlockMark = { block: b, changes, action: worst(changes.map((c) => c.action)), hint: '' };
      mark.hint = hintFor(mark);
      marks.push(mark);
    }
    if (marks.length) byFile.set(f.path, marks);
  }
  return { byFile, orphans: [...unmatched] };
}

function counts(changes: Change[], withNoop: boolean): string {
  const n = new Map<Action, number>();
  for (const c of changes) n.set(c.action, (n.get(c.action) ?? 0) + 1);
  return SEVERITY.filter((a) => n.has(a) && (withNoop || a !== 'noop'))
    .map((a) => `${n.get(a)} ${a === 'noop' ? 'unchanged' : a}`)
    .join(' · ');
}

export function hintFor(mark: BlockMark): string {
  const { block, changes } = mark;
  if (block.kind === 'module') {
    const s = counts(changes, false);
    return s ? `module: ${s}` : 'no changes';
  }
  if (changes.length > 1) return `${changes.length} instances: ${counts(changes, true)}`;
  const c = changes[0];
  const moved = c.previousAddress && c.previousAddress !== c.address ? `moved from ${c.previousAddress}` : '';
  let what = actionHint(c);
  // An import says so first: `import`, `import, then replace — forced by …`.
  if (c.importing !== undefined) what = c.action === 'noop' ? 'import' : `import, then ${what}`;
  else if (moved && c.action === 'noop') return moved;
  return moved ? `${what} · ${moved}` : what;
}

function actionHint(c: Change): string {
  switch (c.action) {
    case 'replace':
      return c.replaceBy.length ? `replace — forced by ${c.replaceBy.join(', ')}` : 'replace';
    case 'update': {
      const n = c.attrs.length;
      return `update · ${n} attribute${n === 1 ? '' : 's'}`;
    }
    case 'forget':
      return 'forget (state only)';
    case 'noop':
      return 'no changes';
    default:
      return c.action;
  }
}

/**
 * True when most of the plan's root-module resources have no block in the scanned files: the plan was probably made
 * for another Terraform root (e.g. landing_zone/ rather than the repo root).
 */
export function looksLikeOtherRoot(plan: Plan, orphans: Change[]): boolean {
  const roots = plan.changes.filter((c) => c.modulePath.length === 0 && c.mode === 'managed');
  if (!roots.length) return false;
  const lost = orphans.filter((c) => c.modulePath.length === 0 && c.mode === 'managed').length;
  return lost / roots.length > 0.5;
}
