type Node =
  | { kind: 'text'; value: string }
  | { kind: 'value'; path: string; raw: boolean; at: number }
  | { kind: 'if' | 'each'; path: string; yes: Node[]; no: Node[]; at: number };
type Block = Extract<Node, { kind: 'if' | 'each' }>;
type Context = { root: unknown; item?: unknown; index?: number; inLoop: boolean };

function error(template: string, at: number, message: string): Error {
  const before = template.slice(0, at);
  const line = before.split('\n').length;
  const column = at - before.lastIndexOf('\n');
  return new Error(`${message} (line ${line}, column ${column})`);
}

function parse(template: string): Node[] {
  const nodes: Node[] = [];
  const stack: { block: Block; parent: Node[]; hadElse: boolean }[] = [];
  let current = nodes;
  let cursor = 0;
  while (cursor < template.length) {
    const at = template.indexOf('{{', cursor);
    if (at === -1) {
      current.push({ kind: 'text', value: template.slice(cursor) });
      break;
    }
    if (at > cursor) current.push({ kind: 'text', value: template.slice(cursor, at) });
    const raw = template.startsWith('{{{', at);
    const opening = raw ? 3 : 2;
    const closing = raw ? '}}}' : '}}';
    const end = template.indexOf(closing, at + opening);
    if (end === -1) throw error(template, at, 'Unclosed tag');
    const tag = template.slice(at + opening, end).trim();
    cursor = end + closing.length;
    if (!raw && tag.startsWith('!')) continue;
    if (!raw && tag.startsWith('#')) {
      const match = /^#(if|each)\s+(.+)$/.exec(tag);
      if (!match) throw error(template, at, `Unknown or malformed block: ${tag}`);
      const block: Block = { kind: match[1] as 'if' | 'each', path: match[2].trim(), yes: [], no: [], at };
      current.push(block);
      stack.push({ block, parent: current, hadElse: false });
      current = block.yes;
    } else if (!raw && tag === 'else') {
      const frame = stack[stack.length - 1];
      if (!frame) throw error(template, at, 'else outside a block');
      if (frame.hadElse) throw error(template, at, 'Duplicate else');
      frame.hadElse = true;
      current = frame.block.no;
    } else if (!raw && tag.startsWith('/')) {
      const frame = stack[stack.length - 1];
      if (!frame || tag.slice(1).trim() !== frame.block.kind) {
        throw error(template, at, `Mismatched closing tag: ${tag}`);
      }
      stack.pop();
      current = frame.parent;
    } else {
      if (!tag) throw error(template, at, 'Empty interpolation path');
      current.push({ kind: 'value', path: tag, raw, at });
    }
  }
  if (stack.length) {
    const frame = stack[stack.length - 1];
    throw error(template, frame.block.at, `Unclosed ${frame.block.kind} block`);
  }
  return nodes;
}

const missing = Symbol('missing');
function lookup(value: unknown, parts: string[]): unknown | typeof missing {
  for (const part of parts) {
    if (value == null || !Object.prototype.hasOwnProperty.call(value, part)) return missing;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

function resolve(path: string, context: Context): unknown {
  const parts = path.split('.');
  if (parts[0] === 'this') return lookup(context.inLoop ? context.item : context.root, parts.slice(1));
  if (parts[0] === '@index') return parts.length === 1 ? context.index : missing;
  if (context.inLoop) {
    const local = lookup(context.item, parts);
    if (local !== missing) return local;
  }
  return lookup(context.root, parts);
}

function truthy(value: unknown): boolean {
  return value !== missing && Boolean(value) && (!Array.isArray(value) || value.length > 0);
}

const escapes: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Render a template, throwing location-aware errors for invalid syntax or non-scalar values. */
export function render(template: string, data: unknown): string {
  const nodes = parse(template);
  function visit(nodes: Node[], context: Context): string {
    let output = '';
    for (const node of nodes) {
      if (node.kind === 'text') {
        output += node.value;
        continue;
      }
      const value = resolve(node.path, context);
      if (node.kind === 'value') {
        if (value === missing || value == null) continue;
        if (typeof value === 'object' || typeof value === 'function') {
          throw error(template, node.at, `Cannot render non-scalar value at "${node.path}"`);
        }
        const text = String(value);
        output += node.raw ? text : text.replace(/[&<>"']/g, char => escapes[char]);
      } else if (node.kind === 'if') {
        output += visit(truthy(value) ? node.yes : node.no, context);
      } else if (Array.isArray(value) && value.length > 0) {
        for (let index = 0; index < value.length; index++) {
          output += visit(node.yes, { root: context.root, item: value[index], index, inLoop: true });
        }
      } else {
        output += visit(node.no, context);
      }
    }
    return output;
  }
  return visit(nodes, { root: data, inLoop: false });
}
