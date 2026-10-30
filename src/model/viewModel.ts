import * as path from 'node:path';
import { Move } from './refactor';
import { SETTINGS, SettingDef, Visibility } from './settings';
import { covers } from './targets';
import { Action, Change, OutputChange, Plan } from './types';

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
  /** A destroy that looks moved: where to (refactor autopilot). */
  movesTo?: string;
  /** Moved here by a moved block: the old address. */
  movedFrom?: string;
  /** Brought under Terraform by an import block: the import id. */
  importing?: string;
}

/** A refactor move as the sidebar shows it. */
export interface MoveItem {
  id: string;
  from: string;
  to: string;
  /** 'module' for a whole module instance, else the resource type. */
  type: string;
  /** Match, 0–100. */
  pct: number;
  ambiguous: boolean;
  /** Destroys it turns into a move (several for a module). */
  n: number;
}

export interface ViewModel {
  state: 'empty' | 'running' | 'ready';
  env?: string;
  envs: string[];
  title: string;
  sub: string;
  counts: { create: number; update: number; replace: number; destroy: number; import: number };
  bar: { action: 'create' | 'update' | 'replace' | 'destroy'; pct: number }[];
  /** The header's bar strip: one bar per change, worst first (at most STRIP; bigger plans are scaled down). */
  strip: ('create' | 'update' | 'replace' | 'destroy')[];
  attention: Item[];
  updates: Item[];
  creates: Item[];
  reads: Item[];
  /** Imports that change nothing or only update; an import that is replaced or destroyed is in attention. */
  imports: Item[];
  /** Changed outside Terraform since the last apply. */
  drift: Item[];
  /** Objects a moved block moved, with nothing else to do. */
  movedItems: Item[];
  outputs: OutputChange[];
  unchanged: number;
  /** Objects a moved block moved (no-op or update with a previous address). */
  moved: number;
  /** Destroy/create pairs that look like one object under a new address. */
  moves: MoveItem[];
  /** Destroys the moves would keep. */
  movable: number;
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
  /** How each optional section shows (settings planLens.sidebar.*). */
  sections: Record<Section, Visibility>;
  /** The settings page: every setting with its current value. */
  settings: (SettingDef & { value: Visibility | boolean | string })[];
}

export type Section = 'drift' | 'imports' | 'moved' | 'reads' | 'outputs';
const SECTIONS: Section[] = ['drift', 'imports', 'moved', 'reads', 'outputs'];

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
  /** findMoves(plan), computed once per plan by the store. */
  moves?: Move[];
  /** Current values of the planLens.* settings the page shows, by key without the prefix (unset: default). */
  settings?: Record<string, unknown>;
}

export function ago(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

/** A setting's value from the options, or its default; a value of the wrong kind falls back to the default too. */
function setting(o: ViewOptions, key: string): Visibility | boolean | string {
  const def = SETTINGS.find((s) => s.key === key)!;
  const v = o.settings?.[key];
  return typeof v === typeof def.default && (def.type !== 'visibility' || ['shown', 'discreet', 'hidden'].includes(v as string)) ? (v as Visibility | boolean | string) : def.default;
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
  if (c.importing !== undefined && (c.action === 'replace' || c.action === 'destroy')) {
    sub = [`imported, then ${c.action === 'replace' ? 'replaced' : 'destroyed'}${sub[0]?.startsWith('forced by') ? ` — ${sub[0]}` : ''}`];
  }
  return {
    address: c.address,
    title: title(c),
    action: c.action,
    sub,
    ...(c.previousAddress && c.previousAddress !== c.address ? { movedFrom: c.previousAddress } : {}),
    ...(c.importing !== undefined ? { importing: c.importing } : {}),
    ...(c.moduleAddress ? { module: c.moduleAddress } : {}),
    ...(at ? { loc: `${path.posix.basename(at.file)}:${at.line + 1}` } : {}),
    orphan: !at,
  };
}

const STRIP = 48;

const ORDER: Partial<Record<Action, number>> = { replace: 0, destroy: 1, forget: 2 };

export function toViewModel(plan: Plan | undefined, o: ViewOptions): ViewModel {
  if (o.running && o.runEnv) {
    // A plan of another env stays loaded until the new one lands; showing it under the run would mislabel it.
    if (plan && plan.env !== o.runEnv) plan = undefined;
    o = { ...o, env: o.runEnv };
  }
  const counts = { create: 0, update: 0, replace: 0, destroy: 0, import: 0 };
  const vm: ViewModel = {
    state: o.running ? 'running' : plan ? 'ready' : 'empty',
    ...(o.env ? { env: o.env } : {}),
    envs: o.envs,
    title: '',
    sub: '',
    counts,
    bar: [],
    strip: [],
    attention: [],
    updates: [],
    creates: [],
    reads: [],
    imports: [],
    drift: [],
    movedItems: [],
    outputs: [],
    unchanged: 0,
    moved: 0,
    moves: [],
    movable: 0,
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
    sections: Object.fromEntries(SECTIONS.map((s) => [s, setting(o, `sidebar.${s}`)])) as Record<Section, Visibility>,
    settings: SETTINGS.map((d) => ({ ...d, value: setting(o, d.key) })),
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
  const movesTo = new Map<string, string>();
  // Not offered while a run goes: the plan shown is about to be replaced.
  for (const m of o.running || setting(o, 'refactor') === false ? [] : o.moves ?? []) {
    for (const c of m.covers) movesTo.set(c.from, c.to);
    vm.moves.push({ id: m.id, from: m.from, to: m.to, type: m.type, pct: Math.floor(m.score * 100), ambiguous: m.ambiguous, n: m.covers.length });
    vm.movable += m.covers.length;
  }
  for (const c of plan.changes) {
    if (c.previousAddress && c.previousAddress !== c.address) vm.moved++;
    if (c.importing !== undefined) counts.import++;
    // An import with nothing else, or only an update: its own list. Replaced or destroyed: below, needs a look.
    if (c.importing !== undefined && (c.action === 'noop' || c.action === 'update')) {
      if (c.action === 'update') counts.update++;
      vm.imports.push(item(c, o.locate));
      continue;
    }
    if (c.action === 'noop' && c.previousAddress && c.previousAddress !== c.address) {
      vm.movedItems.push(item(c, o.locate));
      continue;
    }
    switch (c.action) {
      case 'create': counts.create++; vm.creates.push(item(c, o.locate)); break;
      case 'update': counts.update++; vm.updates.push(item(c, o.locate)); break;
      case 'replace': counts.replace++; vm.attention.push(item(c, o.locate)); break;
      case 'destroy': case 'forget': {
        counts.destroy++;
        const it = item(c, o.locate);
        if (movesTo.has(c.address)) it.movesTo = movesTo.get(c.address);
        vm.attention.push(it);
        break;
      }
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
  vm.drift = (plan.drift ?? []).map((c) => {
    const it = item(c, o.locate);
    it.sub = [c.action === 'destroy' ? 'deleted outside Terraform' : c.attrs.slice(0, 3).map((a) => a.path).join(', ') + (c.attrs.length > 3 ? ` +${c.attrs.length - 3}` : '')];
    return it;
  });
  vm.outputs = [...(plan.outputs ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  vm.attention.sort((a, b) => ORDER[a.action]! - ORDER[b.action]! || byAddr(a, b));
  [vm.updates, vm.creates, vm.reads, vm.imports, vm.drift, vm.movedItems].forEach((l) => l.sort(byAddr));
  const total = counts.create + counts.update + counts.replace + counts.destroy;
  // Nothing to apply on a no-change plan (forget-only plans still count: destroy holds them).
  // An import-only plan still has something to apply.
  vm.canApply = vm.canApply && total + counts.import > 0;
  vm.applyOff = vm.applyOff && total + counts.import > 0;
  if (total) {
    // Each action keeps its share of the strip (at least one bar when present).
    const scale = Math.min(1, STRIP / total);
    vm.strip = (['destroy', 'replace', 'update', 'create'] as const).flatMap((a) => Array<typeof a>(counts[a] ? Math.max(1, Math.round(counts[a] * scale)) : 0).fill(a));
    vm.bar = (['create', 'update', 'replace', 'destroy'] as const)
      .filter((a) => counts[a])
      .map((a) => ({ action: a, pct: (counts[a] / total) * 100 }));
  }
  return vm;
}
