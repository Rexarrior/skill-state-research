type Position = { line: number; column: number };
type Node =
  | { kind: 'text'; value: string }
  | { kind: 'value'; path: string; raw: boolean; at: Position }
  | { kind: 'if' | 'each'; path: string; yes: Node[]; no: Node[]; at: Position };
type Block = Extract<Node, { kind: 'if' | 'each' }>;

function fail(message: string, at: Position): never {
  throw new Error(`${message} at line ${at.line}, column ${at.column}`);
}

function parse(template: string): Node[] {
  const nodes: Node[] = [];
  const stack: { block: Block; parent: Node[]; hasElse: boolean }[] = [];
  let target = nodes;
  let offset = 0;
  let line = 1;
  let column = 1;
  function advance(end: number) {
    for (; offset < end; offset++) {
      if (template[offset] === '\n') { line++; column = 1; }
      else column++;
    }
  }
  while (offset < template.length) {
    const start = template.indexOf('{{', offset);
    if (start < 0) { target.push({ kind: 'text', value: template.slice(offset) }); break; }
    if (start > offset) target.push({ kind: 'text', value: template.slice(offset, start) });
    advance(start);
    const at = { line, column };
    const raw = template.startsWith('{{{', start);
    const opener = raw ? 3 : 2;
    const closer = raw ? '}}}' : '}}';
    const end = template.indexOf(closer, start + opener);
    if (end < 0) fail('Unclosed tag', at);
    const tag = template.slice(start + opener, end).trim();
    advance(end + closer.length);
    if (!raw && tag.startsWith('!')) continue;
    if (!raw && tag.startsWith('#')) {
      const match = /^#(\S+)(?:\s+(.+))?$/.exec(tag);
      const name = match?.[1];
      if (name !== 'if' && name !== 'each') fail(`Unknown block "${name ?? tag}"`, at);
      const path = match?.[2]?.trim();
      if (!path) fail(`Missing path for ${name}`, at);
      const block: Block = { kind: name, path, yes: [], no: [], at };
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
      if (tag !== `/${frame.block.kind}`) fail(`Mismatched closing tag ${tag}; expected /${frame.block.kind}`, at);
      stack.pop();
      target = frame.parent;
    } else {
      if (!tag) fail('Empty interpolation path', at);
      target.push({ kind: 'value', path: tag, raw, at });
    }
  }
  const frame = stack[stack.length - 1];
  if (frame) fail(`Unclosed ${frame.block.kind} block`, frame.block.at);
  return nodes;
}

const missing = Symbol('missing');
type Context = { root: unknown; item: unknown; inLoop: boolean; index?: number };
function lookup(value: unknown, path: string): unknown {
  for (const key of path.split('.')) {
    if (!key || value == null || !Object.prototype.hasOwnProperty.call(value, key)) return missing;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}
function resolve(path: string, context: Context): unknown {
  if (path === '@index') return context.index;
  if (path === 'this') return context.inLoop ? context.item : context.root;
  if (path.startsWith('this.')) return lookup(context.inLoop ? context.item : context.root, path.slice(5));
  if (context.inLoop) {
    const value = lookup(context.item, path);
    if (value !== missing) return value;
  }
  return lookup(context.root, path);
}
function truthy(value: unknown): boolean {
  return value !== missing && Boolean(value) && (!Array.isArray(value) || value.length > 0);
}
function scalar(value: unknown, path: string, at: Position): string {
  if (value === missing || value == null) return '';
  if (typeof value === 'object' || typeof value === 'function' || typeof value === 'symbol') {
    fail(`Cannot render "${path}" as scalar text (${Array.isArray(value) ? 'array' : typeof value})`, at);
  }
  return String(value);
}
function escapeHtml(value: string): string {
  const entities: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return value.replace(/[&<>"']/g, char => entities[char]!);
}
function evaluate(nodes: Node[], context: Context): string {
  let output = '';
  for (const node of nodes) {
    if (node.kind === 'text') { output += node.value; continue; }
    const value = resolve(node.path, context);
    if (node.kind === 'value') {
      const text = scalar(value, node.path, node.at);
      output += node.raw ? text : escapeHtml(text);
    } else if (node.kind === 'if') {
      output += evaluate(truthy(value) ? node.yes : node.no, context);
    } else if (Array.isArray(value) && value.length > 0) {
      for (let index = 0; index < value.length; index++) {
        output += evaluate(node.yes, { root: context.root, item: value[index], inLoop: true, index });
      }
    } else output += evaluate(node.no, context);
  }
  return output;
}

/** Render a template with HTML escaping and nested if/each blocks. */
export function render(template: string, data: unknown): string {
  return evaluate(parse(template), { root: data, item: data, inLoop: false });
}
