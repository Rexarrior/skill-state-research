type Position = { line: number; column: number };
type Node =
  | { kind: 'text'; text: string }
  | { kind: 'value'; path: string; raw: boolean; at: Position }
  | { kind: 'if' | 'each'; path: string; body: Node[]; otherwise: Node[]; at: Position };
type Block = Extract<Node, { kind: 'if' | 'each' }>;
type Context = { root: unknown; current: unknown; index?: number };

function fail(message: string, at: Position): never {
  throw new Error(`${message} at line ${at.line}, column ${at.column}`);
}

function checkPath(path: string, at: Position): string {
  if (!/^(?:@index|[^\s.{}#/@!]+(?:\.[^\s.{}#/@!]+)*)$/.test(path)) {
    fail(`Invalid path ${JSON.stringify(path)}`, at);
  }
  return path;
}

function parse(template: string): Node[] {
  const result: Node[] = [];
  const stack: { block: Block; parent: Node[]; hasElse: boolean }[] = [];
  let output = result;
  let cursor = 0;
  let line = 1;
  let column = 1;
  const advance = (end: number) => {
    for (; cursor < end; cursor++) {
      if (template[cursor] === '\n') { line++; column = 1; }
      else column++;
    }
  };
  while (cursor < template.length) {
    const start = template.indexOf('{{', cursor);
    if (start === -1) { output.push({ kind: 'text', text: template.slice(cursor) }); break; }
    if (start > cursor) output.push({ kind: 'text', text: template.slice(cursor, start) });
    advance(start);
    const at = { line, column };
    const raw = template.startsWith('{{{', start);
    const opener = raw ? 3 : 2;
    const closer = raw ? '}}}' : '}}';
    const end = template.indexOf(closer, start + opener);
    if (end === -1) fail('Unclosed tag', at);
    const tag = template.slice(start + opener, end).trim();
    advance(end + closer.length);
    if (!raw && tag.startsWith('!')) continue;
    if (!raw && tag.startsWith('#')) {
      const match = /^#(\S+)(?:\s+(.+))?$/.exec(tag);
      const kind = match?.[1];
      if (kind !== 'if' && kind !== 'each') fail(`Unknown block ${JSON.stringify(kind ?? tag)}`, at);
      const block: Block = { kind, path: checkPath(match?.[2]?.trim() ?? '', at), body: [], otherwise: [], at };
      output.push(block);
      stack.push({ block, parent: output, hasElse: false });
      output = block.body;
    } else if (!raw && tag === 'else') {
      const frame = stack[stack.length - 1];
      if (!frame) fail('else outside a block', at);
      if (frame.hasElse) fail('Duplicate else', at);
      frame.hasElse = true;
      output = frame.block.otherwise;
    } else if (!raw && tag.startsWith('/')) {
      const frame = stack[stack.length - 1];
      if (!frame) fail(`Unexpected closing tag ${tag}`, at);
      if (tag !== `/${frame.block.kind}`) fail(`Mismatched closing tag ${tag}; expected /${frame.block.kind}`, at);
      stack.pop();
      output = frame.parent;
    } else {
      output.push({ kind: 'value', path: checkPath(tag, at), raw, at });
    }
  }
  const remaining = stack[stack.length - 1];
  if (remaining) fail(`Unclosed ${remaining.block.kind} block`, remaining.block.at);
  return result;
}

const MISSING = Symbol('missing');
function lookup(value: unknown, parts: string[]): unknown {
  for (const part of parts) {
    if (value === null || value === undefined || !Object.prototype.hasOwnProperty.call(value, part)) return MISSING;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

function resolve(path: string, context: Context): unknown {
  if (path === '@index') return context.index;
  const parts = path.split('.');
  if (parts[0] === 'this') {
    const value = lookup(context.current, parts.slice(1));
    return value === MISSING ? undefined : value;
  }
  const local = lookup(context.current, parts);
  if (local !== MISSING) return local;
  const root = lookup(context.root, parts);
  return root === MISSING ? undefined : root;
}

function truthy(value: unknown): boolean {
  return Array.isArray(value) ? value.length > 0 : Boolean(value);
}

function scalar(value: unknown, path: string, at: Position): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object' || typeof value === 'function') {
    fail(`Cannot interpolate non-scalar value at path ${JSON.stringify(path)}`, at);
  }
  return String(value);
}

const escapes: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function renderNodes(nodes: Node[], context: Context): string {
  const chunks: string[] = [];
  for (const node of nodes) {
    if (node.kind === 'text') { chunks.push(node.text); continue; }
    const value = resolve(node.path, context);
    if (node.kind === 'value') {
      const text = scalar(value, node.path, node.at);
      chunks.push(node.raw ? text : text.replace(/[&<>"']/g, character => escapes[character]!));
    } else if (node.kind === 'if') {
      chunks.push(renderNodes(truthy(value) ? node.body : node.otherwise, context));
    } else if (Array.isArray(value) && value.length > 0) {
      for (let index = 0; index < value.length; index++) {
        chunks.push(renderNodes(node.body, { root: context.root, current: value[index], index }));
      }
    } else {
      chunks.push(renderNodes(node.otherwise, context));
    }
  }
  return chunks.join('');
}

/** Render a template with escaped interpolations and nested if/each blocks. */
export function render(template: string, data: unknown): string {
  return renderNodes(parse(template), { root: data, current: data });
}
