import * as path from 'node:path';
import { Action, Change, Plan } from './types';

export interface Item {
  address: string;
  /** `type.name[key]`, never the module path. */
  title: string;
  action: Action;
  sub: string[];
  module?: string;
  /** `main.tf:443` (1-based). */
  loc?: string;
  orphan: boolean;
}

export interface ViewModel {
  state: 'empty' | 'running' | 'ready';
  env?: string;
  envs: string[];
  title: string;
  sub: string;
  counts: { create: number; update: number; replace: number; destroy: number };
  bar: { action: 'create' | 'update' | 'replace' | 'destroy'; pct: number }[];
  attention: Item[];
  updates: Item[];
  creates: Item[];
  reads: Item[];
  unchanged: number;
}

export interface ViewOptions {
  env?: string;
  envs: string[];
  running: boolean;
  now: number;
  rootName: string;
  locate: (c: Change) => { file: string; line: number } | undefined;
}

export function ago(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

function title(c: Change): string {
  const key = c.index !== undefined ? `[${JSON.stringify(c.index)}]` : '';
  return `${c.mode === 'data' ? 'data.' : ''}${c.type}.${c.name}${key}`;
}

function item(c: Change, locate: ViewOptions['locate']): Item {
  const at = locate(c);
  let sub: string[] = [];
  if (c.action === 'replace' && c.replaceBy.length) sub = [`forced by ${c.replaceBy.join(', ')}`];
  else if (c.action === 'forget') sub = ['forget (state only)'];
  else if (c.action === 'destroy' && !at) sub = ['removed from code'];
  else if (c.action === 'update') sub = [c.attrs.slice(0, 3).map((a) => a.path).join(', ') + (c.attrs.length > 3 ? ` +${c.attrs.length - 3}` : '')];
  return {
    address: c.address,
    title: title(c),
    action: c.action,
    sub,
    ...(c.moduleAddress ? { module: c.moduleAddress } : {}),
    ...(at ? { loc: `${path.posix.basename(at.file)}:${at.line + 1}` } : {}),
    orphan: !at,
  };
}

const ORDER: Partial<Record<Action, number>> = { replace: 0, destroy: 1, forget: 2 };

export function toViewModel(plan: Plan | undefined, o: ViewOptions): ViewModel {
  const counts = { create: 0, update: 0, replace: 0, destroy: 0 };
  const vm: ViewModel = {
    state: o.running ? 'running' : plan ? 'ready' : 'empty',
    ...(o.env ? { env: o.env } : {}),
    envs: o.envs,
    title: '',
    sub: '',
    counts,
    bar: [],
    attention: [],
    updates: [],
    creates: [],
    reads: [],
    unchanged: 0,
  };
  if (!plan) {
    vm.title = o.env ? `Plan · ${o.env}` : 'No plan yet';
    return vm;
  }
  const label = plan.env || path.basename(plan.source);
  vm.title = `Plan · ${label}`;
  const origin = plan.env ? o.rootName : path.basename(plan.source);
  vm.sub = [origin, ago(o.now - plan.loadedAt), plan.terraformVersion && `TF ${plan.terraformVersion}`].filter(Boolean).join(' · ');

  const byAddr = (a: Item, b: Item) => a.address.localeCompare(b.address);
  for (const c of plan.changes) {
    switch (c.action) {
      case 'create': counts.create++; vm.creates.push(item(c, o.locate)); break;
      case 'update': counts.update++; vm.updates.push(item(c, o.locate)); break;
      case 'replace': counts.replace++; vm.attention.push(item(c, o.locate)); break;
      case 'destroy': case 'forget': counts.destroy++; vm.attention.push(item(c, o.locate)); break;
      case 'read': vm.reads.push(item(c, o.locate)); break;
      default: vm.unchanged++;
    }
  }
  vm.attention.sort((a, b) => ORDER[a.action]! - ORDER[b.action]! || byAddr(a, b));
  [vm.updates, vm.creates, vm.reads].forEach((l) => l.sort(byAddr));
  const total = counts.create + counts.update + counts.replace + counts.destroy;
  if (total) {
    vm.bar = (['create', 'update', 'replace', 'destroy'] as const)
      .filter((a) => counts[a])
      .map((a) => ({ action: a, pct: (counts[a] / total) * 100 }));
  }
  return vm;
}
