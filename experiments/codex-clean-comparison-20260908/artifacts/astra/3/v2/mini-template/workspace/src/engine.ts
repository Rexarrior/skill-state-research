type Location = { line: number; column: number };
type Node =
  | { kind: 'text'; value: string }
  | { kind: 'value'; path: string; raw: boolean; at: Location }
  | { kind: 'if' | 'each'; path: string; body: Node[]; alternate: Node[]; at: Location };
type Block = Extract<Node, { kind: 'if' | 'each' }>;
type Context = { root: unknown; item: unknown; index?: number };

function fail(message: string, at: Location): never {
  throw new Error(`${message} at line ${at.line}, column ${at.column}`);
}

function checkPath(path: string, at: Location): void {
  if (!/^(?:@index|[^\s.{}#/*!]+)(?:\.[^\s.{}#/*!]+)*$/.test(path)) {
    fail(`Invalid path ${JSON.stringify(path)}`, at);
  }
}

function parse(template: string): Node[] {
  const nodes: Node[] = [];
  const stack: { block: Block; parent: Node[]; hasElse: boolean }[] = [];
  let target = nodes;
  let offset = 0;
  let line = 1;
  let column = 1;
  function advance(end: number): void {
    for (; offset < end; offset++) {
      if (template[offset] === '\n') { line++; column = 1; }
      else column++;
    }
  }
  while (offset < template.length) {
    const start = template.indexOf('{{', offset);
    if (start === -1) { target.push({ kind: 'text', value: template.slice(offset) }); break; }
    if (start > offset) target.push({ kind: 'text', value: template.slice(offset, start) });
    advance(start);
    const at = { line, column };
    const raw = template.startsWith('{{{', start);
    const opening = raw ? 3 : 2;
    const close = template.indexOf(raw ? '}}}' : '}}', start + opening);
    if (close === -1) fail('Unclosed tag', at);
    const tag = template.slice(start + opening, close).trim();
    advance(close + opening);
    if (!raw && tag.startsWith('!')) continue;
    if (!raw && tag.startsWith('#')) {
      const match = /^#(\S+)(?:\s+([\s\S]*))?$/.exec(tag);
      const name = match?.[1];
      if (name !== 'if' && name !== 'each') fail(`Unknown block ${JSON.stringify(name ?? tag)}`, at);
      const path = match?.[2]?.trim() ?? '';
      checkPath(path, at);
      const block: Block = { kind: name, path, body: [], alternate: [], at };
      target.push(block);
      stack.push({ block, parent: target, hasElse: false });
      target = block.body;
    } else if (!raw && tag === 'else') {
      const frame = stack.at(-1);
      if (!frame) fail('else outside a block', at);
      if (frame.hasElse) fail('Duplicate else', at);
      frame.hasElse = true;
      target = frame.block.alternate;
    } else if (!raw && tag.startsWith('/')) {
      const frame = stack.at(-1);
      if (!frame) fail(`Unexpected closing tag ${tag}`, at);
      if (tag !== `/${frame.block.kind}`) fail(`Mismatched closing tag ${tag}; expected /${frame.block.kind}`, at);
      stack.pop();
      target = frame.parent;
    } else {
      checkPath(tag, at);
      target.push({ kind: 'value', path: tag, raw, at });
    }
  }
  const frame = stack.at(-1);
  if (frame) fail(`Unclosed ${frame.block.kind} block`, frame.block.at);
  return nodes;
}

const missing = Symbol('missing');
function lookup(value: unknown, parts: string[]): unknown | typeof missing {
  for (const part of parts) {
    if (value === null || value === undefined || !Object.prototype.hasOwnProperty.call(value, part)) return missing;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}
function resolve(path: string, context: Context): unknown {
  const parts = path.split('.');
  let value: unknown;
  if (parts[0] === 'this') value = lookup(context.item, parts.slice(1));
  else if (parts[0] === '@index') value = lookup(context.index, parts.slice(1));
  else {
    value = lookup(context.item, parts);
    if (value === missing) value = lookup(context.root, parts);
  }
  return value === missing ? undefined : value;
}
function truthy(value: unknown): boolean {
  return value !== '' && value !== 0 && value !== false && value !== null &&
    value !== undefined && !(Array.isArray(value) && value.length === 0);
}
function scalar(value: unknown, path: string, at: Location): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object' || typeof value === 'function') {
    fail(`Cannot render ${JSON.stringify(path)} as scalar text (${Array.isArray(value) ? 'array' : typeof value})`, at);
  }
  return String(value);
}
const entities: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function evaluate(nodes: Node[], context: Context, output: string[]): void {
  for (const node of nodes) {
    if (node.kind === 'text') { output.push(node.value); continue; }
    const value = resolve(node.path, context);
    if (node.kind === 'value') {
      const text = scalar(value, node.path, node.at);
      output.push(node.raw ? text : text.replace(/[&<>"']/g, character => entities[character]!));
    } else if (node.kind === 'if') {
      evaluate(truthy(value) ? node.body : node.alternate, context, output);
    } else if (Array.isArray(value) && value.length > 0) {
      for (let index = 0; index < value.length; index++) {
        evaluate(node.body, { root: context.root, item: value[index], index }, output);
      }
    } else evaluate(node.alternate, context, output);
  }
}

/** Render a template using own-property paths and HTML-escaped interpolation. */
export function render(template: string, data: unknown): string {
  const output: string[] = [];
  evaluate(parse(template), { root: data, item: data }, output);
  return output.join('');
}
