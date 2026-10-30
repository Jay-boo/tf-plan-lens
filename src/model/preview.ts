// Edit preview: on save, plan only the blocks edited since the last full plan (-target, no refresh, no lock) and say on
// the edited lines what that would do. Pure: which blocks changed, their addresses, and the hints per line.
import { Block, scanBlocks } from './hclScanner';
import { Change } from './types';

const blockKey = (b: Block) => `${b.kind}|${b.type ?? ''}|${b.name}`;
const blockText = (lines: string[], b: Block) => lines.slice(b.startLine, b.endLine + 1).join('\n');

/** Blocks of `after` that are new or whose text differs from `before`. */
export function changedBlocks(before: string, after: string): Block[] {
  const old = before.split(/\r?\n/);
  const now = after.split(/\r?\n/);
  const was = new Map(scanBlocks(before).map((b) => [blockKey(b), blockText(old, b)]));
  return scanBlocks(after).filter((b) => was.get(blockKey(b)) !== blockText(now, b));
}

/** Address of a block in a module: `azurerm_x.y`, `data.azurerm_x.y`, `module.m`, under each call path of the module. */
export function blockTargets(b: Block, modulePaths: string[][]): string[] {
  const own = b.kind === 'module' ? `module.${b.name}` : `${b.kind === 'data' ? 'data.' : ''}${b.type}.${b.name}`;
  return modulePaths.map((p) => [...p.map((m) => `module.${m}`), own].join('.'));
}

/** Module call paths whose source folder is `dir` (posix, relative to the root; '' = the root module). */
export function callsOf(dir: string, moduleDirs: Record<string, string>): string[][] {
  if (dir === '') return [[]];
  return Object.entries(moduleDirs).filter(([, d]) => d === dir).map(([k]) => k.split('.'));
}

export interface PreviewHint {
  /** 0-based line in the file. */
  line: number;
  text: string;
  look: 'create' | 'update' | 'replace' | 'destroy' | 'read' | 'noop';
}

const short = (s: string, n = 40) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** Line of a top-level attribute or nested block of the block (`location = …`, `site_config {`), if written there. */
function attrLine(lines: string[], b: Block, name: string): number | undefined {
  const re = new RegExp(`^\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*(=|\\{)`);
  for (let ln = b.startLine + 1; ln < b.endLine; ln++) if (re.test(lines[ln])) return ln;
  return undefined;
}

/** What the preview says on a block's lines: a summary on the header, the verdict on each changed attribute. */
export function previewHints(text: string, b: Block, changes: Change[]): PreviewHint[] {
  const lines = text.split(/\r?\n/);
  const real = changes.filter((c) => c.action !== 'read');
  const look = (a: Change['action']): PreviewHint['look'] => (a === 'forget' ? 'destroy' : a);
  if (!real.length || real.every((c) => c.action === 'noop')) return [{ line: b.startLine, text: '✓ preview: no changes', look: 'noop' }];
  const worst = real.find((c) => c.action === 'replace') ?? real.find((c) => c.action === 'destroy') ?? real.find((c) => c.action === 'update') ?? real[0];
  const n = real.filter((c) => c.action !== 'noop').length;
  const many = real.length > 1 ? ` (${n} of ${real.length} instances)` : '';
  const why = worst.action === 'replace' && worst.replaceBy.length ? ` — forced by ${worst.replaceBy.join(', ')}` : '';
  const out: PreviewHint[] = [{ line: b.startLine, text: `◆ preview: ${worst.action}${why}${many}`, look: look(worst.action) }];
  const seen = new Set<number>();
  for (const a of worst.attrs) {
    const top = a.path.split(/[.[]/)[0];
    const ln = attrLine(lines, b, top);
    if (ln === undefined || seen.has(ln)) continue;
    seen.add(ln);
    if (a.forcesReplace) out.push({ line: ln, text: '⟳ forces replacement', look: 'replace' });
    else if (a.sensitive) out.push({ line: ln, text: '~ (sensitive) changes', look: 'update' });
    else if (a.unknown) out.push({ line: ln, text: '~ known after apply', look: 'update' });
    else out.push({ line: ln, text: `~ ${short(a.before || 'null')} → ${short(a.after || 'null')}`, look: worst.action === 'replace' ? 'replace' : 'update' });
  }
  return out;
}
