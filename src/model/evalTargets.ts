// What to show a value for in a root module file: locals, variables, for_each / count, outputs. Not a parser: like
// hclScanner it tracks strings, interpolations, heredocs, comments and bracket depth well enough to find each
// attribute of a top-level block and the full (possibly multi-line) text of its expression.

export interface EvalTarget {
  /** 0-based line the value is shown on. */
  line: number;
  /** HCL expression to evaluate in the root module: `local.subnets`, or the attribute's own text. */
  expr: string;
  kind: 'local' | 'variable' | 'instances' | 'output';
}

const HEADER = /^\s*(locals|variable|output|resource|data|module)\b(?:\s+"([^"]*)")?(?:\s+"([^"]*)")?\s*\{/;
const ATTR = /^\s*([A-Za-z_][A-Za-z0-9_-]*)\s*=(?![=>])/;
const HEREDOC = /<<-?([A-Za-z_][A-Za-z0-9_]*)\s*$/;
/** Values that only exist inside an instance (or a provisioner): nothing to show at the block level. */
const PER_INSTANCE = /\b(each|count|self)\.|\bcount\.index\b/;

interface LineInfo {
  /** Bracket depth ({ [ ( outside strings) at the start of the line. */
  depth: number;
  /** The line starts in code (not in a string, heredoc or block comment). */
  code: boolean;
  /** Index where a # or // comment starts on the line, outside strings; -1 when none. */
  comment: number;
}

/** Per-line state of the text. */
function scan(lines: string[]): LineInfo[] {
  const out: LineInfo[] = [];
  let depth = 0;
  let blockComment = false;
  let heredoc: string | undefined;
  // 's': in a string's text; a number: in an interpolation (`${`) opened at that bracket depth.
  const stack: ('s' | number)[] = [];
  for (const line of lines) {
    const info: LineInfo = { depth, code: !blockComment && !heredoc && !stack.length, comment: -1 };
    out.push(info);
    if (heredoc) {
      if (line.trim() === heredoc) heredoc = undefined;
      continue;
    }
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      const next = line[i + 1];
      if (blockComment) {
        if (ch === '*' && next === '/') { blockComment = false; i++; }
        continue;
      }
      if (stack[stack.length - 1] === 's') {
        if (ch === '\\') i++;
        else if (ch === '"') stack.pop();
        else if ((ch === '$' || ch === '%') && next === ch) i++; // $${ and %%{ are literal
        else if ((ch === '$' || ch === '%') && next === '{') { stack.push(depth); depth++; i++; }
        continue;
      }
      if (!stack.length && (ch === '#' || (ch === '/' && next === '/'))) { info.comment = i; break; }
      if (ch === '/' && next === '*') { blockComment = true; i++; continue; }
      if (ch === '"') { stack.push('s'); continue; }
      if (!stack.length && ch === '<' && next === '<' && HEREDOC.test(line.slice(i))) { heredoc = HEREDOC.exec(line.slice(i))![1]; break; }
      if (ch === '{' || ch === '[' || ch === '(') depth++;
      else if (ch === '}' || ch === ']' || ch === ')') {
        depth--;
        if (stack.length && stack[stack.length - 1] === depth) stack.pop();
      }
    }
  }
  return out;
}

export function evalTargets(text: string): EvalTarget[] {
  const lines = text.split(/\r?\n/);
  const info = scan(lines);
  const targets: EvalTarget[] = [];
  let block: { kind: string; name?: string } | undefined;
  for (let ln = 0; ln < lines.length; ln++) {
    const at = info[ln];
    if (!at.code) continue;
    if (at.depth === 0) {
      const h = HEADER.exec(lines[ln]);
      block = h ? { kind: h[1], name: h[2] } : undefined;
      if (h?.[1] === 'variable' && h[2]) targets.push({ line: ln, expr: `var.${h[2]}`, kind: 'variable' });
      continue;
    }
    if (at.depth !== 1 || !block) continue;
    const a = ATTR.exec(lines[ln]);
    if (!a) continue;
    const name = a[1];
    const kind = block.kind === 'locals' ? 'local'
      : (block.kind === 'resource' || block.kind === 'data' || block.kind === 'module') && (name === 'for_each' || name === 'count') ? 'instances'
      : block.kind === 'output' && name === 'value' ? 'output'
      : undefined;
    if (!kind) continue;
    if (kind === 'local') {
      targets.push({ line: ln, expr: `local.${name}`, kind });
      continue;
    }
    // The expression runs until the line where the depth is back to the block's and no string is open.
    let end = ln;
    while (end + 1 < lines.length && !(info[end + 1].code && info[end + 1].depth === 1)) end++;
    const parts = lines.slice(ln, end + 1);
    parts[0] = parts[0].slice(a[0].length);
    const last = info[end].comment >= 0 && end === ln ? info[end].comment - a[0].length : info[end].comment;
    if (last >= 0) parts[parts.length - 1] = parts[parts.length - 1].slice(0, last);
    const expr = parts.join('\n').trim();
    if (!expr || PER_INSTANCE.test(expr)) continue;
    targets.push({ line: ln, expr, kind });
  }
  return targets;
}
