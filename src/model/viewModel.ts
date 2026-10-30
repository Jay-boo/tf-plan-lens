import * as path from 'node:path';
import { covers } from './targets';
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
  /** In a targeted plan: not picked, terraform added it as a dependency of a target. */
  pulled?: boolean;
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
  /** The plan came from a file, not from Run. */
  loaded: boolean;
  /** Last run / load failure, shown in the card. */
  error?: string;
  /** The running task is terraform apply. */
  applying: boolean;
  /** Where environments are looked for, as shown to the user (`environments/`, a glob, a folder). */
  envFolder: string;
  /** Apply is enabled (planLens.allowApply) and this plan was run here, so its saved plan can be applied. */
  canApply: boolean;
  /** This plan could be applied but planLens.allowApply is off: Apply… explains how to turn it on. */
  applyOff: boolean;
  /** The plan was run here, so it can be re-run with -target. */
  canTarget: boolean;
  /** The plan's -target addresses ([] for a full plan). */
  targets: string[];
  /** Changes in a targeted plan that no target picked (dependencies terraform pulled in). */
  pulled: number;
  /** Modules with changes, to target a whole module at once. */
  modules: { address: string; n: number }[];
  /** While running: the log's last lines. */
  tail: string[];
}

export interface ViewOptions {
  env?: string;
  /** While running: the env the run is for, which the header shows over `env`. */
  runEnv?: string;
  envs: string[];
  running: boolean;
  now: number;
  rootName: string;
  locate: (c: Change) => { file: string; line: number } | undefined;
  error?: string;
  applying?: boolean;
  envFolder?: string;
  canApply?: boolean;
  applyOff?: boolean;
  tail?: string[];
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
  if (o.running && o.runEnv) {
    // A plan of another env stays loaded until the new one lands; showing it under the run would mislabel it.
    if (plan && plan.env !== o.runEnv) plan = undefined;
    o = { ...o, env: o.runEnv };
  }
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
    loaded: !!plan && !plan.env,
    ...(o.error ? { error: o.error } : {}),
    applying: !!o.running && !!o.applying,
    envFolder: o.envFolder ?? '',
    canApply: !!plan && !o.running && !!o.canApply,
    applyOff: !!plan && !o.running && !o.canApply && !!o.applyOff,
    canTarget: !!plan?.env && !o.running,
    targets: plan?.targets ?? [],
    pulled: 0,
    modules: [],
    tail: o.running ? o.tail ?? [] : [],
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
  const targets = vm.targets;
  const modules = new Map<string, number>();
  for (const it of [...vm.attention, ...vm.updates, ...vm.creates]) {
    if (it.module) modules.set(it.module, (modules.get(it.module) ?? 0) + 1);
    if (targets.length && !targets.some((t) => covers(t, it.address))) {
      it.pulled = true;
      vm.pulled++;
    }
  }
  vm.modules = [...modules].map(([address, n]) => ({ address, n })).sort((a, b) => a.address.localeCompare(b.address));
  vm.attention.sort((a, b) => ORDER[a.action]! - ORDER[b.action]! || byAddr(a, b));
  [vm.updates, vm.creates, vm.reads].forEach((l) => l.sort(byAddr));
  const total = counts.create + counts.update + counts.replace + counts.destroy;
  // Nothing to apply on a no-change plan (forget-only plans still count: destroy holds them).
  vm.canApply = vm.canApply && total > 0;
  vm.applyOff = vm.applyOff && total > 0;
  if (total) {
    vm.bar = (['create', 'update', 'replace', 'destroy'] as const)
      .filter((a) => counts[a])
      .map((a) => ({ action: a, pct: (counts[a] / total) * 100 }));
  }
  return vm;
}
