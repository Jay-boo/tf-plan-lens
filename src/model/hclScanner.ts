// Finds top-level resource / data / module blocks in .tf text. Not a parser: it only tracks strings, heredocs,
// comments and brace depth well enough to know where each block starts and ends.

export interface Block {
  kind: 'resource' | 'data' | 'module';
  type?: string;
  name: string;
  /** 0-based. */
  startLine: number;
  endLine: number;
  /** Column just after the header's `{`. */
  headerEnd: number;
}

const RESOURCE = /^\s*(resource|data)\s+"([^"]+)"\s+"([^"]+)"\s*\{/;
const MODULE = /^\s*module\s+"([^"]+)"\s*\{/;
const HEREDOC = /^<<(-?)([A-Za-z_][A-Za-z0-9_]*)\s*$/;

export function scanBlocks(text: string): Block[] {
  const lines = text.split(/\r?\n/);
  const blocks: Block[] = [];
  let open: Block | undefined;
  let depth = 0;
  let blockComment = false;
  let heredoc: { tag: string } | undefined;
  // Inside a string: each entry is the brace depth of an open `${`, the string itself is the last level.
  let interp: number[] | undefined;

  for (let ln = 0; ln < lines.length; ln++) {
    const line = lines[ln];
    if (heredoc) {
      // HCL trims whitespace around the closing marker for both <<TAG and <<-TAG.
      if (line.trim() === heredoc.tag) heredoc = undefined;
      continue;
    }
    if (depth === 0 && !blockComment && !interp) {
      const r = RESOURCE.exec(line);
      const m = r ? undefined : MODULE.exec(line);
      if (r || m) {
        const headerEnd = (r ?? m)![0].length;
        open = r
          ? { kind: r[1] as 'resource' | 'data', type: r[2], name: r[3], startLine: ln, endLine: ln, headerEnd }
          : { kind: 'module', name: m![1], startLine: ln, endLine: ln, headerEnd };
        blocks.push(open);
      }
    }
    let hd: RegExpExecArray | null = null;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      const n = line[i + 1];
      if (blockComment) {
        if (c === '*' && n === '/') { blockComment = false; i++; }
        continue;
      }
      if (interp) {
        const inString = interp[interp.length - 1] === -1;
        if (inString) {
          if (c === '\\') { i++; continue; }
          if (c === '"') { interp.pop(); if (!interp.length) interp = undefined; continue; }
          if (c === '$' && n === '{') { interp.push(0); i++; }
          continue;
        }
        // Inside `${ ... }`: track braces and nested strings.
        if (c === '"') { interp.push(-1); continue; }
        if (c === '{') interp[interp.length - 1]++;
        else if (c === '}') {
          if (interp[interp.length - 1] === 0) interp.pop();
          else interp[interp.length - 1]--;
        }
        continue;
      }
      if (c === '#' || (c === '/' && n === '/')) break;
      // A heredoc opener runs to the end of the line; only in code, never in a comment or string.
      if (c === '<' && n === '<' && (hd = HEREDOC.exec(line.slice(i)))) break;
      if (c === '/' && n === '*') { blockComment = true; i++; continue; }
      if (c === '"') { interp = [-1]; continue; }
      if (c === '{') depth++;
      else if (c === '}') {
        depth = Math.max(0, depth - 1);
        if (depth === 0 && open) { open.endLine = ln; open = undefined; }
      }
    }
    // A string never spans lines in HCL; recover rather than swallowing the file.
    interp = undefined;
    if (hd) heredoc = { tag: hd[2] };
  }
  if (open) open.endLine = lines.length - 1;
  return blocks;
}
