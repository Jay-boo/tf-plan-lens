// Completions from evaluated values: after `local.x.`, `var.x["`, `each.value.` the keys the value really has. Pure:
// where the cursor is in such a reference, and the keys at that spot.
import { inlineValue } from './evalBatch';

export interface CompletionSpot {
  /** `local.x` / `var.x`: evaluated as is; `each.value`: the elements of the block's for_each. */
  root: string;
  /** Keys / indexes from the root to the value being completed. */
  path: (string | number)[];
  /** What was typed to ask: `.` an attribute, `["` a key, `[` an index or key. */
  trigger: '.' | '["' | '[';
  /** Characters typed after the trigger (the completion replaces them). */
  typed: string;
}

const SEG = String.raw`(?:\.[A-Za-z_][\w-]*|\["[^"]*"\]|\[\d+\])`;
const SPOT = new RegExp(String.raw`(local\.[A-Za-z_][\w-]*|var\.[A-Za-z_][\w-]*|each\.value)(${SEG}*)(\.|\["|\[)([\w-]*|(?<=\[")[^"\]]*)$`);

/** The reference the cursor is completing, from the line's text before the cursor. */
export function completionSpot(before: string): CompletionSpot | undefined {
  const m = SPOT.exec(before);
  if (!m) return undefined;
  const path: (string | number)[] = [];
  for (const s of m[2].matchAll(new RegExp(SEG, 'g'))) {
    const seg = s[0];
    if (seg.startsWith('.')) path.push(seg.slice(1));
    else if (seg.startsWith('["')) path.push(seg.slice(2, -2));
    else path.push(Number(seg.slice(1, -1)));
  }
  return { root: m[1], path, trigger: m[3] as CompletionSpot['trigger'], typed: m[4] };
}

/** The value a path leads to, or undefined. */
export function walk(value: unknown, path: (string | number)[]): unknown {
  let v = value;
  for (const p of path) {
    if (v === null || typeof v !== 'object') return undefined;
    v = (v as Record<string, unknown>)[p as string];
  }
  return v;
}

/** each.value of a for_each: one element per instance (a map's values, a set's members). */
export function eachValues(forEach: unknown): unknown[] {
  if (Array.isArray(forEach)) return forEach;
  if (forEach && typeof forEach === 'object') return Object.values(forEach);
  return [];
}

export interface KeyItem {
  key: string;
  /** Short value, for the completion's detail. */
  detail: string;
  /** Index: the position, to keep the value's own order. */
  order: number;
}

/** Keys at the spot: an object's attributes, a list's indexes; several values (each.value) merged. */
export function keysOf(values: unknown[]): KeyItem[] {
  const out = new Map<string, KeyItem>();
  for (const v of values) {
    if (Array.isArray(v)) v.forEach((x, i) => !out.has(String(i)) && out.set(String(i), { key: String(i), detail: inlineValue(x, 40), order: out.size }));
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (!out.has(k)) out.set(k, { key: k, detail: inlineValue(x, 40), order: out.size });
    }
  }
  return [...out.values()];
}

export const IDENT = /^[A-Za-z_][A-Za-z0-9_-]*$/;
