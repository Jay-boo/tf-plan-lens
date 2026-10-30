// Refactor autopilot: a destroy and a create of the same type whose values match are most likely one object under a
// new address (renamed, moved into a module, count → for_each). Each pair becomes a `moved` block, so Terraform keeps
// the object instead of recreating it. Pure: no vscode.
import { Change, Plan } from './types';

export interface Move {
  /** `from>to`: what the webview sends back to pick moves. */
  id: string;
  from: string;
  to: string;
  /** Resource type, or 'module' for a folded module move. */
  type: string;
  /** 0..1: weighted share of the create's values found equal in the destroy (folded: the lowest of its pairs). */
  score: number;
  /** Another candidate matches about as well: shown, but not picked by default. */
  ambiguous: boolean;
  /** The destroy → create pairs it stands for (several for a module move). */
  covers: { from: string; to: string }[];
}

const MIN_SCORE = 0.75;
const TIE = 0.02;
/** Fewer telling values than this, under another name: too thin to tick for the user. */
const MIN_EVIDENCE = 2;

interface Pair {
  d: Change;
  c: Change;
  score: number;
  /** Same name (and so likely the same block, re-keyed or moved): breaks ties. */
  sameName: boolean;
  /** How many telling values the score rests on. */
  evidence: number;
}

/** The moves the plan's destroys and creates make, most certain first, modules folded. */
export function findMoves(plan: Plan): Move[] {
  const byType = new Map<string, { d: Change[]; c: Change[] }>();
  for (const ch of plan.changes) {
    if (ch.mode !== 'managed' || !ch.values) continue;
    const side = ch.action === 'destroy' ? 'd' : ch.action === 'create' ? 'c' : undefined;
    if (!side) continue;
    const g = byType.get(ch.type) ?? { d: [], c: [] };
    g[side].push(ch);
    byType.set(ch.type, g);
  }
  const pairs: (Pair & { ambiguous: boolean })[] = [];
  for (const { d, c } of byType.values()) {
    if (!d.length || !c.length) continue;
    const weight = weights([...d, ...c]);
    const all: Pair[] = [];
    for (const dd of d) {
      for (const cc of c) {
        const { score, evidence } = similarity(dd, cc, weight);
        if (score >= MIN_SCORE) all.push({ d: dd, c: cc, score, evidence, sameName: dd.name === cc.name });
      }
    }
    all.sort((a, b) => b.score - a.score || Number(b.sameName) - Number(a.sameName) || a.d.address.localeCompare(b.d.address) || a.c.address.localeCompare(b.c.address));
    const used = new Set<string>();
    for (const p of all) {
      if (used.has(p.d.address) || used.has(p.c.address)) continue;
      // A rival still free on either side, nearly as good and not just as good by name: the pick is a guess.
      const thin = p.evidence < MIN_EVIDENCE && !p.sameName;
      const ambiguous = thin || all.some((q) => q !== p && (q.d === p.d || q.c === p.c) && !used.has(q.d.address) && !used.has(q.c.address)
        && q.score >= p.score - TIE && q.sameName === p.sameName);
      used.add(p.d.address).add(p.c.address);
      pairs.push({ ...p, ambiguous });
    }
  }
  return fold(plan, pairs);
}

/**
 * A leaf value held by every object of the type tells nothing apart (location = "westeurope" everywhere): weight 0.
 * With only two objects, everything counts.
 */
function weights(objects: Change[]): (path: string, value: string) => number {
  if (objects.length <= 2) return () => 1;
  const seen = new Map<string, Map<string, number>>();
  for (const o of objects) {
    for (const [p, v] of Object.entries(o.values!)) {
      const m = seen.get(p) ?? new Map<string, number>();
      m.set(v, (m.get(v) ?? 0) + 1);
      seen.set(p, m);
    }
  }
  return (p, v) => (seen.get(p)?.get(v) === objects.length ? 0 : 1);
}

/** Weighted share of the create's values that the destroy has too (0 when nothing is telling), and how many counted. */
function similarity(d: Change, c: Change, weight: (path: string, value: string) => number): { score: number; evidence: number } {
  let total = 0;
  let same = 0;
  for (const [p, v] of Object.entries(c.values!)) {
    const w = weight(p, v);
    total += w;
    if (d.values![p] === v) same += w;
  }
  return { score: total ? same / total : 0, evidence: total };
}

/** Address of a change relative to its module instance: `terraform_data.this["k"]`. */
const local = (ch: Change) => (ch.moduleAddress ? ch.address.slice(ch.moduleAddress.length + 1) : ch.address);

/**
 * Pairs that move a whole module instance (every destroy in it, same local addresses, one target instance) become one
 * module move: `module.old` → `module.new`, `module.inst[0]` → `module.inst["i0"]`.
 */
function fold(plan: Plan, pairs: (Pair & { ambiguous: boolean })[]): Move[] {
  const destroysIn = new Map<string, number>();
  for (const ch of plan.changes) {
    if (ch.moduleAddress && (ch.action === 'destroy' || ch.action === 'forget')) destroysIn.set(ch.moduleAddress, (destroysIn.get(ch.moduleAddress) ?? 0) + 1);
  }
  const groups = new Map<string, (Pair & { ambiguous: boolean })[]>();
  for (const p of pairs) {
    if (!p.d.moduleAddress || !p.c.moduleAddress || p.d.moduleAddress === p.c.moduleAddress || local(p.d) !== local(p.c)) continue;
    const k = `${p.d.moduleAddress}>${p.c.moduleAddress}`;
    groups.set(k, [...(groups.get(k) ?? []), p]);
  }
  const folded = new Set<Pair>();
  const moves: Move[] = [];
  for (const [k, g] of groups) {
    const [from, to] = k.split('>');
    if (g.length !== destroysIn.get(from) || g.some((p) => p.ambiguous)) continue;
    g.forEach((p) => folded.add(p));
    moves.push({
      id: k, from, to, type: 'module',
      score: Math.min(...g.map((p) => p.score)),
      ambiguous: false,
      covers: g.map((p) => ({ from: p.d.address, to: p.c.address })).sort((a, b) => a.from.localeCompare(b.from)),
    });
  }
  for (const p of pairs) {
    if (folded.has(p)) continue;
    moves.push({ id: `${p.d.address}>${p.c.address}`, from: p.d.address, to: p.c.address, type: p.d.type, score: p.score, ambiguous: p.ambiguous, covers: [{ from: p.d.address, to: p.c.address }] });
  }
  return moves.sort((a, b) => Number(a.ambiguous) - Number(b.ambiguous) || a.from.localeCompare(b.from));
}

/** The `moved` blocks for the moves, under a `# header` comment. */
export function movedHcl(moves: Move[], header: string): string {
  return [`# ${header}`, ...moves.map((m) => `moved {\n  from = ${m.from}\n  to   = ${m.to}\n}\n`)].join('\n');
}

/** The `from` addresses of the moved blocks already in a file (comments skipped). */
export function movedFroms(text: string): Set<string> {
  const code = text.replace(/#.*$|\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  return new Set([...code.matchAll(/\bmoved\s*\{[^}]*?\bfrom\s*=\s*([^\s}]+)/g)].map((m) => m[1]));
}
