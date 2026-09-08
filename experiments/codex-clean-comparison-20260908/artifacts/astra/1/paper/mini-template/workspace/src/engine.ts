type Location = { line: number; column: number };
type Node =
  | { kind: 'text'; value: string }
  | { kind: 'value'; path: string; raw: boolean; loc: Location }
  | Block;
type Block = { kind: 'if' | 'each'; path: string; yes: Node[]; no: Node[]; loc: Location };
type Frame = { block: Block; alternate: boolean };
type Context = { root: unknown; item: unknown; index?: number };

function fail(message: string, loc: Location): never {
  throw new Error(`${message} at line ${loc.line}, column ${loc.column}`);
}

function parse(template: string): Node[] {
  const nodes: Node[] = [];
  const stack: Frame[] = [];
  let offset = 0;
  let line = 1;
  let column = 1;
  const advance = (end: number) => {
    for (; offset < end; offset++) {
      if (template[offset] === '\n') { line++; column = 1; }
      else column++;
    }
  };
  const append = (node: Node) => {
    const frame = stack[stack.length - 1];
    (frame ? (frame.alternate ? frame.block.no : frame.block.yes) : nodes).push(node);
  };
  while (offset < template.length) {
    const start = template.indexOf('{{', offset);
    if (start === -1) { append({ kind: 'text', value: template.slice(offset) }); break; }
    if (start > offset) append({ kind: 'text', value: template.slice(offset, start) });
    advance(start);
    const loc = { line, column };
    const raw = template.startsWith('{{{', start);
    const openLength = raw ? 3 : 2;
    const closing = raw ? '}}}' : '}}';
    const end = template.indexOf(closing, start + openLength);
    if (end === -1) fail('Unclosed tag', loc);
    const tag = template.slice(start + openLength, end).trim();
    advance(end + closing.length);
    if (!raw && tag.startsWith('!')) continue;
    if (!raw && tag.startsWith('#')) {
      const match = /^#(if|each)\s+(.+)$/.exec(tag);
      if (!match) fail(`Unknown or invalid block ${JSON.stringify(tag)}`, loc);
      const block: Block = { kind: match[1] as 'if' | 'each', path: match[2]!.trim(), yes: [], no: [], loc };
      append(block);
      stack.push({ block, alternate: false });
    } else if (!raw && tag === 'else') {
      const frame = stack[stack.length - 1];
      if (!frame) fail('else outside a block', loc);
      if (frame.alternate) fail('Duplicate else', loc);
      frame.alternate = true;
    } else if (!raw && tag.startsWith('/')) {
      const frame = stack[stack.length - 1];
      if (!frame) fail(`Unexpected closing tag ${tag}`, loc);
      if (tag !== `/${frame.block.kind}`) fail(`Mismatched closing tag ${tag}; expected /${frame.block.kind}`, loc);
      stack.pop();
    } else {
      if (!tag) fail('Empty interpolation', loc);
      append({ kind: 'value', path: tag, raw, loc });
    }
  }
  if (stack.length) {
    const block = stack[stack.length - 1]!.block;
    fail(`Unclosed ${block.kind} block`, block.loc);
  }
  return nodes;
}

const missing = Symbol('missing');
function lookup(value: unknown, path: string): unknown {
  for (const key of path.split('.')) {
    if (!key || value == null || !Object.prototype.hasOwnProperty.call(value, key)) return missing;
    value = (Object(value) as Record<string, unknown>)[key];
  }
  return value;
}
function resolve(path: string, context: Context): unknown {
  let value: unknown;
  if (path === 'this') value = context.item;
  else if (path.startsWith('this.')) value = lookup(context.item, path.slice(5));
  else if (path === '@index') value = context.index;
  else {
    value = lookup(context.item, path);
    if (value === missing) value = lookup(context.root, path);
  }
  return value === missing ? undefined : value;
}
function truthy(value: unknown): boolean {
  return Array.isArray(value) ? value.length > 0 : Boolean(value);
}
function scalar(value: unknown, loc: Location): string {
  if (value == null) return '';
  if (typeof value === 'object' || typeof value === 'function') {
    fail('Cannot render non-scalar value (object, array, or function)', loc);
  }
  return String(value);
}
const escapes: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function evaluate(nodes: Node[], context: Context, output: string[]): void {
  for (const node of nodes) {
    if (node.kind === 'text') { output.push(node.value); continue; }
    const value = resolve(node.path, context);
    if (node.kind === 'value') {
      const text = scalar(value, node.loc);
      output.push(node.raw ? text : text.replace(/[&<>"']/g, character => escapes[character]!));
    } else if (node.kind === 'if') {
      evaluate(truthy(value) ? node.yes : node.no, context, output);
    } else if (Array.isArray(value) && value.length) {
      for (let index = 0; index < value.length; index++) {
        evaluate(node.yes, { root: context.root, item: value[index], index }, output);
      }
    } else evaluate(node.no, context, output);
  }
}

/** Render a template, throwing source-located errors for invalid structure or scalar values. */
export function render(template: string, data: unknown): string {
  const nodes = parse(template);
  const output: string[] = [];
  evaluate(nodes, { root: data, item: data }, output);
  return output.join('');
}
