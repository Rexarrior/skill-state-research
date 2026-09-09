type Location = { line: number; column: number };
type Node =
  | { kind: 'text'; value: string }
  | { kind: 'value'; path: string; raw: boolean; at: Location }
  | { kind: 'if' | 'each'; path: string; yes: Node[]; no: Node[]; at: Location };
type Block = Extract<Node, { kind: 'if' | 'each' }>;
type Context = { root: unknown; item?: unknown; index?: number };

function fail(message: string, at: Location): never {
  throw new Error(`${message} at line ${at.line}, column ${at.column}`);
}

function parse(template: string): Node[] {
  const nodes: Node[] = [];
  const stack: { block: Block; parent: Node[]; hasElse: boolean }[] = [];
  let target = nodes;
  let cursor = 0;
  let line = 1;
  let column = 1;
  function advance(end: number) {
    while (cursor < end) {
      if (template[cursor++] === '\n') { line++; column = 1; }
      else column++;
    }
  }
  function path(value: string, at: Location): string {
    if (!/^(?:@index|this|[^\s.{}#\/!@]+)(?:\.[^\s.{}#\/!@]+)*$/.test(value)) {
      fail(`Invalid path ${JSON.stringify(value)}`, at);
    }
    return value;
  }
  while (cursor < template.length) {
    const start = template.indexOf('{{', cursor);
    if (start === -1) { target.push({ kind: 'text', value: template.slice(cursor) }); break; }
    if (start > cursor) target.push({ kind: 'text', value: template.slice(cursor, start) });
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
      const name = match?.[1];
      if (name !== 'if' && name !== 'each') fail(`Unknown block ${JSON.stringify(name ?? tag)}`, at);
      const block: Block = { kind: name, path: path(match?.[2] ?? '', at), yes: [], no: [], at };
      target.push(block);
      stack.push({ block, parent: target, hasElse: false });
      target = block.yes;
    } else if (!raw && tag === 'else') {
      const frame = stack[stack.length - 1];
      if (!frame) fail('else outside a block', at);
      if (frame.hasElse) fail('Duplicate else', at);
      frame.hasElse = true;
      target = frame.block.no;
    } else if (!raw && tag.startsWith('/')) {
      const frame = stack[stack.length - 1];
      if (!frame) fail(`Unexpected closing tag ${tag}`, at);
      if (tag.slice(1).trim() !== frame.block.kind) fail(`Mismatched closing tag ${tag}; expected /${frame.block.kind}`, at);
      stack.pop();
      target = frame.parent;
    } else {
      target.push({ kind: 'value', path: path(tag, at), raw, at });
    }
  }
  const frame = stack[stack.length - 1];
  if (frame) fail(`Unclosed ${frame.block.kind} block`, frame.block.at);
  return nodes;
}

const missing = Symbol('missing');
function lookup(value: unknown, parts: string[]): unknown {
  for (const part of parts) {
    if (value == null || !Object.prototype.hasOwnProperty.call(value, part)) return missing;
    value = (Object(value) as Record<string, unknown>)[part];
  }
  return value;
}

function resolve(path: string, context: Context): unknown {
  const parts = path.split('.');
  if (parts[0] === 'this') return lookup(context.index === undefined ? context.root : context.item, parts.slice(1));
  if (parts[0] === '@index') return lookup(context.index, parts.slice(1));
  if (context.index !== undefined) {
    const local = lookup(context.item, parts);
    if (local !== missing) return local;
  }
  return lookup(context.root, parts);
}

function truthy(value: unknown): boolean {
  return value !== missing && Boolean(value) && (!Array.isArray(value) || value.length > 0);
}

function scalar(value: unknown, at: Location): string {
  if (value === missing || value == null) return '';
  if (typeof value === 'object' || typeof value === 'function') {
    fail(`Cannot interpolate ${Array.isArray(value) ? 'array' : typeof value} as scalar text`, at);
  }
  return String(value);
}

const escapes: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function output(nodes: Node[], context: Context, chunks: string[]): void {
  for (const node of nodes) {
    if (node.kind === 'text') { chunks.push(node.value); continue; }
    const value = resolve(node.path, context);
    if (node.kind === 'value') {
      const text = scalar(value, node.at);
      chunks.push(node.raw ? text : text.replace(/[&<>"']/g, char => escapes[char]!));
    } else if (node.kind === 'if') {
      output(truthy(value) ? node.yes : node.no, context, chunks);
    } else if (Array.isArray(value) && value.length > 0) {
      for (let index = 0; index < value.length; index++) {
        output(node.yes, { root: context.root, item: value[index], index }, chunks);
      }
    } else {
      output(node.no, context, chunks);
    }
  }
}

/** Render a template with escaped interpolation and nested conditional/array blocks. */
export function render(template: string, data: unknown): string {
  const nodes = parse(template);
  const chunks: string[] = [];
  output(nodes, { root: data }, chunks);
  return chunks.join('');
}
