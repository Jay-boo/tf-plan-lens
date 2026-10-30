import * as path from 'node:path';
import { Action, AttrChange, Change, OutputChange, Plan } from './types';

type Json = any; // terraform show -json output is untyped

const MAX_VALUE = 80;

export function parsePlan(json: unknown, meta: { env: string; source: string; loadedAt: number }): Plan {
  const j = json as Json;
  if (!j || typeof j !== 'object' || !j.format_version || !(Array.isArray(j.resource_changes) || j.planned_values)) {
    throw new Error('Not a Terraform plan JSON');
  }
  const moduleDirs: Record<string, string> = {};
  collectModuleDirs(j.configuration?.root_module, [], '', moduleDirs);
  return {
    ...meta,
    terraformVersion: String(j.terraform_version ?? ''),
    changes: (j.resource_changes ?? []).map(toChange),
    moduleDirs,
    drift: (j.resource_drift ?? []).map(toChange).filter((c: Change) => c.action !== 'noop'),
    outputs: Object.entries<Json>(j.output_changes ?? {}).flatMap(([name, oc]) => toOutput(name, oc)),
  };
}

function toOutput(name: string, oc: Json): OutputChange[] {
  const action = toAction(oc?.actions ?? []);
  if (action !== 'create' && action !== 'update' && action !== 'destroy') return [];
  const sensitive = !!(oc.before_sensitive || oc.after_sensitive);
  const unknown = oc.after_unknown === true;
  return [{
    name, action, sensitive, unknown,
    before: sensitive ? '' : render(oc.before ?? undefined),
    after: sensitive || unknown ? '' : render(oc.after ?? undefined),
  }];
}

function toChange(rc: Json): Change {
  const ch = rc.change ?? {};
  const replaceBy: string[] = (ch.replace_paths ?? []).map((p: (string | number)[]) => joinPath(p));
  const moduleAddress = String(rc.module_address ?? '');
  return {
    address: String(rc.address),
    moduleAddress,
    modulePath: modulePathOf(moduleAddress),
    mode: rc.mode === 'data' ? 'data' : 'managed',
    type: String(rc.type),
    name: String(rc.name),
    ...(rc.index !== undefined ? { index: rc.index } : {}),
    action: toAction(ch.actions ?? []),
    attrs: diff(ch, new Set(replaceBy)),
    replaceBy,
    ...(rc.action_reason ? { reason: String(rc.action_reason) } : {}),
    ...(rc.previous_address ? { previousAddress: String(rc.previous_address) } : {}),
    // Imports by id, or by identity (Terraform 1.12+) shown as its JSON.
    ...(ch.importing ? { importing: ch.importing.id !== undefined ? String(ch.importing.id) : JSON.stringify(ch.importing.identity ?? {}) } : {}),
    ...comparable(rc, ch),
  };
}

/** The values a destroy or create is recognised by (see Change.values). */
function comparable(rc: Json, ch: Json): { values?: Record<string, string> } {
  if (rc.mode === 'data') return {};
  const actions = (ch.actions ?? []).join(',');
  if (actions === 'delete') return { values: leaves(ch.before, ch.before_sensitive, undefined) };
  if (actions === 'create') return { values: leaves(ch.after, ch.after_sensitive, ch.after_unknown) };
  return {};
}

function leaves(value: Json, sensitive: Json, unknown: Json): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (v: Json, s: Json, u: Json, parts: (string | number)[]): void => {
    if (s === true || u === true || v === null || v === undefined || v === '') return;
    if (typeof v !== 'object') {
      out[joinPath(parts)] = JSON.stringify(v);
      return;
    }
    for (const [k, child] of Object.entries<Json>(v)) {
      const key = Array.isArray(v) ? Number(k) : k;
      walk(child, s?.[k], u?.[k], [...parts, key]);
    }
  };
  walk(value, sensitive, unknown, []);
  return out;
}

function toAction(actions: string[]): Action {
  const s = actions.join(',');
  if (s === 'delete,create' || s === 'create,delete') return 'replace';
  switch (s) {
    case 'create': return 'create';
    case 'update': return 'update';
    case 'delete': return 'destroy';
    case 'forget': return 'forget';
    case 'read': return 'read';
    default: return 'noop';
  }
}

/** `module.a["k"].module.b[0]` → ['a', 'b']. */
function modulePathOf(moduleAddress: string): string[] {
  const out: string[] = [];
  const re = /module\.([A-Za-z0-9_-]+)(?:\[[^\]]*\])?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(moduleAddress))) out.push(m[1]);
  return out;
}

function collectModuleDirs(mod: Json, prefix: string[], dir: string, out: Record<string, string>): void {
  for (const [name, call] of Object.entries<Json>(mod?.module_calls ?? {})) {
    const source = String(call?.source ?? '');
    if (!source.startsWith('./') && !source.startsWith('../')) continue;
    const key = [...prefix, name];
    const childDir = path.posix.normalize(path.posix.join(dir || '.', source)).replace(/\/+$/, '').replace(/^\.$/, '');
    out[key.join('.')] = childDir;
    collectModuleDirs(call.module, key, childDir, out);
  }
}

function joinPath(parts: (string | number)[]): string {
  let s = '';
  for (const p of parts) s += typeof p === 'number' ? `[${p}]` : s ? `.${p}` : p;
  return s;
}

/** A mask (sensitive / unknown) is true at a path when it, or any ancestor, is `true`. */
function maskAt(mask: Json, parts: (string | number)[]): boolean {
  let m = mask;
  for (const p of parts) {
    if (m === true) return true;
    if (!m || typeof m !== 'object') return false;
    m = m[p as any];
  }
  return m === true;
}

function isLeaf(v: Json): boolean {
  return v === null || typeof v !== 'object' || (Array.isArray(v) ? v.length === 0 : Object.keys(v).length === 0);
}

function render(v: Json): string {
  if (v === undefined) return '';
  const s = JSON.stringify(v);
  return s.length > MAX_VALUE ? s.slice(0, MAX_VALUE) + '…' : s;
}

function diff(ch: Json, forced: Set<string>): AttrChange[] {
  const out: AttrChange[] = [];
  const before = ch.before ?? undefined;
  const after = ch.after ?? undefined;
  const walk = (b: Json, a: Json, parts: (string | number)[]): void => {
    const sensitive = maskAt(ch.before_sensitive, parts) || maskAt(ch.after_sensitive, parts);
    const unknown = maskAt(ch.after_unknown, parts);
    const leaf = (b === undefined || isLeaf(b)) && (a === undefined || isLeaf(a));
    if (!leaf && !unknown && !(sensitive && parts.length > 0)) {
      const keys = new Set<string | number>();
      for (const v of [b, a]) {
        if (Array.isArray(v)) v.forEach((_, i) => keys.add(i));
        else if (v && typeof v === 'object') Object.keys(v).forEach((k) => keys.add(k));
      }
      // Unknown attributes may be absent from `after` but present in the mask.
      const um = maskOf(ch.after_unknown, parts);
      if (um && typeof um === 'object') Object.keys(um).forEach((k) => keys.add(Array.isArray(um) ? Number(k) : k));
      for (const k of keys) walk(b?.[k as any], a?.[k as any], [...parts, k]);
      return;
    }
    if (parts.length === 0) return;
    if (!unknown && !sensitive && JSON.stringify(b) === JSON.stringify(a)) return;
    if (sensitive && !unknown && JSON.stringify(b) === JSON.stringify(a)) return;
    const p = joinPath(parts);
    // A node rendered whole (e.g. an unknown block) is sensitive if anything inside it is.
    const hidden = sensitive || hasTrue(maskOf(ch.before_sensitive, parts)) || hasTrue(maskOf(ch.after_sensitive, parts));
    out.push({
      path: p,
      before: hidden ? '' : render(b),
      after: hidden || unknown ? '' : render(a),
      sensitive: hidden,
      unknown,
      // A replace path also covers what is inside it: `triggers_replace` forces `triggers_replace[0]`.
      forcesReplace: [...forced].some((f) => p === f || p.startsWith(f + '.') || p.startsWith(f + '[')),
    });
  };
  walk(before, after, []);
  return out;
}

function hasTrue(mask: Json): boolean {
  if (mask === true) return true;
  return !!mask && typeof mask === 'object' && Object.values(mask).some(hasTrue);
}

function maskOf(mask: Json, parts: (string | number)[]): Json {
  let m = mask;
  for (const p of parts) {
    if (!m || typeof m !== 'object') return undefined;
    m = m[p as any];
  }
  return m;
}
