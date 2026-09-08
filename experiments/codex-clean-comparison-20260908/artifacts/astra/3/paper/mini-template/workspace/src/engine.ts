type Location = { line: number; column: number };
type Node =
  | { kind: 'text'; text: string }
  | { kind: 'value'; path: string; raw: boolean; loc: Location }
  | { kind: 'if' | 'each'; path: string; yes: Node[]; no: Node[]; loc: Location };
type Block = Extract<Node, { kind: 'if' | 'each' }>;
type Context = { root: unknown; item: unknown; index?: number };

function fail(message: string, loc: Location): never {
  throw new Error(`${message} at line ${loc.line}, column ${loc.column}`);
}

function validatePath(path: string, loc: Location): void {
  if (!/^(?:@index|[^\s.{}#\/!@]+)(?:\.[^\s.{}#\/!@]+)*$/.test(path)) {
    fail(`Invalid path ${JSON.stringify(path)}`, loc);
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
    if (start === -1) { target.push({ kind: 'text', text: template.slice(offset) }); break; }
    if (start > offset) target.push({ kind: 'text', text: template.slice(offset, start) });
    advance(start);
    const loc = { line, column };
    const raw = template.startsWith('{{{', start);
    const close = raw ? '}}}' : '}}';
    const end = template.indexOf(close, start + (raw ? 3 : 2));
    if (end === -1) fail('Unclosed tag', loc);
    const tag = template.slice(start + (raw ? 3 : 2), end).trim();
    advance(end + close.length);
    if (!raw && tag.startsWith('!')) continue;
    if (!raw && tag.startsWith('#')) {
      const match = /^#(\S+)(?:\s+(.+))?$/.exec(tag);
      const name = match?.[1];
      if (name !== 'if' && name !== 'each') fail(`Unknown block ${JSON.stringify(name ?? tag)}`, loc);
      const path = match?.[2]?.trim() ?? '';
      validatePath(path, loc);
      const block: Block = { kind: name, path, yes: [], no: [], loc };
      target.push(block);
      stack.push({ block, parent: target, hasElse: false });
      target = block.yes;
    } else if (!raw && tag === 'else') {
      const frame = stack[stack.length - 1];
      if (!frame) fail('else outside a block', loc);
      if (frame.hasElse) fail('Duplicate else', loc);
      frame.hasElse = true;
      target = frame.block.no;
    } else if (!raw && tag.startsWith('/')) {
      const frame = stack[stack.length - 1];
      if (!frame) fail(`Unexpected closing tag ${tag}`, loc);
      if (tag !== `/${frame.block.kind}`) fail(`Mismatched closing tag ${tag}; expected /${frame.block.kind}`, loc);
      stack.pop();
      target = frame.parent;
    } else {
      validatePath(tag, loc);
      target.push({ kind: 'value', path: tag, raw, loc });
    }
  }
  const open = stack[stack.length - 1];
  if (open) fail(`Unclosed ${open.block.kind} block`, open.block.loc);
  return nodes;
}

const missing = Symbol('missing');
function lookup(value: unknown, parts: string[]): unknown {
  for (const part of parts) {
    if (value === null || value === undefined || !Object.prototype.hasOwnProperty.call(value, part)) return missing;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}
function resolve(path: string, context: Context): unknown {
  const parts = path.split('.');
  if (parts[0] === 'this') return lookup(context.item, parts.slice(1));
  if (parts[0] === '@index') return lookup(context.index, parts.slice(1));
  const local = lookup(context.item, parts);
  return local === missing ? lookup(context.root, parts) : local;
}
function truthy(value: unknown): boolean {
  return value !== missing && Boolean(value) && !(Array.isArray(value) && value.length === 0);
}
function scalar(value: unknown, path: string, loc: Location): string {
  if (value === missing || value === undefined || value === null) return '';
  if (typeof value === 'object' || typeof value === 'function') {
    fail(`Cannot render ${JSON.stringify(path)} as scalar text (${Array.isArray(value) ? 'array' : typeof value})`, loc);
  }
  return String(value);
}
const escapes: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function evaluate(nodes: Node[], context: Context): string {
  const output: string[] = [];
  for (const node of nodes) {
    if (node.kind === 'text') { output.push(node.text); continue; }
    const value = resolve(node.path, context);
    if (node.kind === 'value') {
      const text = scalar(value, node.path, node.loc);
      output.push(node.raw ? text : text.replace(/[&<>"']/g, character => escapes[character]!));
    } else if (node.kind === 'if') {
      output.push(evaluate(truthy(value) ? node.yes : node.no, context));
    } else if (Array.isArray(value) && value.length > 0) {
      for (let index = 0; index < value.length; index++) {
        output.push(evaluate(node.yes, { root: context.root, item: value[index], index }));
      }
    } else output.push(evaluate(node.no, context));
  }
  return output.join('');
}

/** Render a template using scalar values and nested if/each blocks. */
export function render(template: string, data: unknown): string {
  return evaluate(parse(template), { root: data, item: data });
}
