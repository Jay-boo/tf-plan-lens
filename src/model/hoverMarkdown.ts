import { BlockMark } from './matcher';
import { Action, AttrChange, Change, SEVERITY } from './types';

// Hover markdown for a marked block. VS Code's hover sanitizer keeps <span style="color:var(--vscode-…)">, <del>,
// tables and $(codicons); colours are the extension's contributed theme colours, never hex.

export const ICON: Record<Action, string> = {
  create: 'add', update: 'edit', replace: 'sync', destroy: 'trash', forget: 'trash', read: 'eye', noop: 'circle-small',
};
const TITLE: Record<Action, string> = {
  create: 'Create', update: 'Update', replace: 'Replace', destroy: 'Destroy', forget: 'Forget', read: 'Read', noop: 'No changes',
};
const SUBTITLE: Partial<Record<Action, string>> = {
  replace: 'destroy, then create', forget: 'removed from state only, nothing deleted', read: 'data source',
};
const COLOR: Record<Action, string> = {
  create: 'create', update: 'update', replace: 'replace', destroy: 'destroy', forget: 'destroy', read: 'read', noop: 'read',
};
const MAX_INSTANCES = 5;
const MAX_ROWS = 25;

const color = (c: string, s: string) => `<span style="color:var(--vscode-planLens-${c});">${s}</span>`;

/** Text safe inside a markdown table cell with inline HTML. */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    .replace(/([\\`*_[\]|~#])/g, '\\$1');
}

function cell(a: AttrChange): string {
  if (a.sensitive) return '*(sensitive)*';
  const after = a.unknown ? '*(known after apply)*' : a.after ? color('create', esc(a.after)) : '*(removed)*';
  if (!a.before) return after;
  return `${color('destroy', `<del>${esc(a.before)}</del>`)} → ${after}`;
}

function table(c: Change): string[] {
  if (!c.attrs.length) return [];
  const rows = c.attrs.slice(0, MAX_ROWS).map(
    (a) => `| \`${a.path.replace(/`/g, "'").replace(/\|/g, '\\|')}\` | ${cell(a)} | ${a.forcesReplace ? color('replace', '$(sync) **forces replace**') : ''} |`,
  );
  if (c.attrs.length > MAX_ROWS) rows.push(`| | *+ ${c.attrs.length - MAX_ROWS} more* | |`);
  return ['| attribute | change | |', '|:--|:--|:--|', ...rows, ''];
}

function instanceKey(c: Change): string {
  if (c.index !== undefined) return `[${JSON.stringify(c.index)}]`;
  const m = /(\[[^\]]*\])$/.exec(c.moduleAddress);
  return m ? m[1] : c.address;
}

const bySeverity = (a: Change, b: Change) => SEVERITY.indexOf(a.action) - SEVERITY.indexOf(b.action);

export function hoverMarkdown(mark: BlockMark): string {
  const { block, changes, action } = mark;
  const out: string[] = [];
  const sub = SUBTITLE[action];
  out.push(`${color(COLOR[action], `$(${ICON[action]})`)} **${TITLE[action]}**${sub ? ` · ${sub}` : ''}`, '');

  if (block.kind === 'module') {
    out.push(`\`module.${block.name}\` · ${esc(mark.hint)}`, '');
    const shown = changes.filter((c) => c.action !== 'noop').sort(bySeverity);
    for (const c of shown.slice(0, 10)) out.push(`- ${color(COLOR[c.action], `$(${ICON[c.action]})`)} \`${c.address}\` · ${c.action}`);
    if (shown.length > 10) out.push(`- *+ ${shown.length - 10} more*`);
    out.push('');
  } else if (changes.length === 1) {
    const c = changes[0];
    out.push(`\`${c.address}\``, '', ...table(c));
  } else {
    out.push(`\`${block.kind === 'data' ? 'data.' : ''}${block.type}.${block.name}\` · ${esc(mark.hint)}`, '');
    const sorted = [...changes].sort(bySeverity);
    for (const c of sorted.slice(0, MAX_INSTANCES)) {
      out.push(`${color(COLOR[c.action], `$(${ICON[c.action]})`)} \`${instanceKey(c).replace(/`/g, "'")}\` · ${c.action === 'noop' ? 'unchanged' : c.action}`, '');
      out.push(...table(c));
    }
    if (sorted.length > MAX_INSTANCES) out.push(`*+ ${sorted.length - MAX_INSTANCES} more*`, '');
  }

  const first = block.kind === 'module' ? undefined : changes.length === 1 ? changes[0].address : undefined;
  const links: string[] = [];
  if (first) {
    const arg = encodeURIComponent(JSON.stringify([first]));
    links.push(`[Show in plan](command:planLens.reveal?${arg})`, `[Copy address](command:planLens.copyAddress?${arg})`);
  }
  links.push('[Open log](command:planLens.openLog)');
  out.push('---', '', links.join(' · '));
  return out.join('\n');
}
