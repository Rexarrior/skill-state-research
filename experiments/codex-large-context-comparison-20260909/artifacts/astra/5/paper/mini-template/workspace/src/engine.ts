type Position = { line: number; column: number };
type Node =
  | { kind: 'text'; value: string }
  | { kind: 'value'; path: string; raw: boolean; pos: Position }
  | { kind: 'if' | 'each'; path: string; body: Node[]; alternate: Node[]; pos: Position };
type Block = Extract<Node, { kind: 'if' | 'each' }>;
type Context = { root: unknown; current: unknown; index?: number };

function fail(message: string, pos: Position): never {
  throw new Error(`${message} at line ${pos.line}, column ${pos.column}`);
}

function parse(template: string): Node[] {
  const root: Node[] = [];
  const stack: { block: Block; parent: Node[]; hasElse: boolean }[] = [];
  let nodes = root;
  let offset = 0;
  let line = 1;
  let column = 1;
  function advance(end: number) {
    while (offset < end) {
      if (template[offset++] === '\n') { line++; column = 1; }
      else column++;
    }
  }
  while (offset < template.length) {
    const start = template.indexOf('{{', offset);
    if (start < 0) { nodes.push({ kind: 'text', value: template.slice(offset) }); break; }
    if (start > offset) nodes.push({ kind: 'text', value: template.slice(offset, start) });
    advance(start);
    const pos = { line, column };
    const raw = template.startsWith('{{{', start);
    const opener = raw ? 3 : 2;
    const closer = raw ? '}}}' : '}}';
    const end = template.indexOf(closer, start + opener);
    if (end < 0) fail('Unclosed tag', pos);
    const tag = template.slice(start + opener, end).trim();
    advance(end + closer.length);
    if (!raw && tag.startsWith('!')) continue;
    if (!raw && tag.startsWith('#')) {
      const match = /^#(if|each)\s+(.+)$/.exec(tag);
      if (!match) fail(`Unknown or invalid block "${tag}"`, pos);
      const block: Block = { kind: match[1] as 'if' | 'each', path: match[2].trim(), body: [], alternate: [], pos };
      nodes.push(block);
      stack.push({ block, parent: nodes, hasElse: false });
      nodes = block.body;
    } else if (!raw && tag === 'else') {
      const frame = stack[stack.length - 1];
      if (!frame) fail('else outside a block', pos);
      if (frame.hasElse) fail('Duplicate else', pos);
      frame.hasElse = true;
      nodes = frame.block.alternate;
    } else if (!raw && tag.startsWith('/')) {
      const frame = stack[stack.length - 1];
      if (!frame) fail(`Unexpected closing tag "${tag}"`, pos);
      if (tag !== `/${frame.block.kind}`) fail(`Mismatched closing tag "${tag}"; expected /${frame.block.kind}`, pos);
      stack.pop();
      nodes = frame.parent;
    } else {
      if (!tag) fail('Empty interpolation', pos);
      nodes.push({ kind: 'value', path: tag, raw, pos });
    }
  }
  if (stack.length) {
    const { block } = stack[stack.length - 1];
    fail(`Unclosed ${block.kind} block`, block.pos);
  }
  return root;
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
  if (path === 'this') return context.current;
  if (path === '@index') return context.index;
  if (path.startsWith('this.')) return lookup(context.current, path.slice(5).split('.'));
  const parts = path.split('.');
  const local = lookup(context.current, parts);
  return local === missing ? lookup(context.root, parts) : local;
}
function truthy(value: unknown): boolean {
  return value !== missing && Boolean(value) && (!Array.isArray(value) || value.length > 0);
}
function scalar(value: unknown, path: string, pos: Position): string {
  if (value === missing || value == null) return '';
  if (typeof value === 'object' || typeof value === 'function') {
    fail(`Cannot render "${path}" as scalar text (${Array.isArray(value) ? 'array' : typeof value})`, pos);
  }
  return String(value);
}
const escapes: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function evaluate(nodes: Node[], context: Context): string {
  let result = '';
  for (const node of nodes) {
    if (node.kind === 'text') { result += node.value; continue; }
    const value = resolve(node.path, context);
    if (node.kind === 'value') {
      const text = scalar(value, node.path, node.pos);
      result += node.raw ? text : text.replace(/[&<>"']/g, char => escapes[char]);
    } else if (node.kind === 'if') {
      result += evaluate(truthy(value) ? node.body : node.alternate, context);
    } else if (Array.isArray(value) && value.length > 0) {
      for (let index = 0; index < value.length; index++) {
        result += evaluate(node.body, { root: context.root, current: value[index], index });
      }
    } else result += evaluate(node.alternate, context);
  }
  return result;
}

/** Render a template, throwing positioned errors for malformed tags and non-scalar values. */
export function render(template: string, data: unknown): string {
  return evaluate(parse(template), { root: data, current: data });
}
