type Context = { root: unknown; item: unknown; index?: number };
type Node =
  | { kind: 'text'; text: string }
  | { kind: 'value'; path: string; raw: boolean; offset: number }
  | { kind: 'if' | 'each'; path: string; body: Node[]; alternate: Node[]; offset: number };
type Block = Extract<Node, { kind: 'if' | 'each' }>;

/** Render a template without evaluating code or invoking data functions. */
export function render(template: string, data: unknown): string {
  function fail(message: string, offset: number): never {
    const before = template.slice(0, offset);
    const line = before.split('\n').length;
    const column = offset - before.lastIndexOf('\n');
    throw new Error(`${message} at line ${line}, column ${column}`);
  }

  function pathTag(path: string, offset: number): string {
    if (!/^(?:@index|[^\s.#/!{}]+)(?:\.[^\s.#/!{}]+)*$/.test(path)) {
      fail(`Invalid path ${JSON.stringify(path)}`, offset);
    }
    return path;
  }

  const nodes: Node[] = [];
  const stack: { node: Block; parent: Node[]; hasElse: boolean }[] = [];
  let current = nodes;
  let cursor = 0;
  while (cursor < template.length) {
    const start = template.indexOf('{{', cursor);
    if (start === -1) {
      current.push({ kind: 'text', text: template.slice(cursor) });
      break;
    }
    if (start > cursor) current.push({ kind: 'text', text: template.slice(cursor, start) });
    const raw = template.startsWith('{{{', start);
    const endTag = raw ? '}}}' : '}}';
    const end = template.indexOf(endTag, start + (raw ? 3 : 2));
    if (end === -1) fail('Unclosed tag', start);
    const tag = template.slice(start + (raw ? 3 : 2), end).trim();
    cursor = end + endTag.length;
    if (!raw && tag.startsWith('!')) continue;
    if (!raw && tag.startsWith('#')) {
      const match = /^#(if|each)\s+(.+)$/.exec(tag);
      if (!match) fail(`Unknown or invalid block ${JSON.stringify(tag)}`, start);
      const node: Block = {
        kind: match[1] as 'if' | 'each', path: pathTag(match[2].trim(), start),
        body: [], alternate: [], offset: start,
      };
      current.push(node);
      stack.push({ node, parent: current, hasElse: false });
      current = node.body;
    } else if (!raw && tag === 'else') {
      const frame = stack[stack.length - 1];
      if (!frame) fail('else outside a block', start);
      if (frame.hasElse) fail('Duplicate else', start);
      frame.hasElse = true;
      current = frame.node.alternate;
    } else if (!raw && tag.startsWith('/')) {
      const frame = stack[stack.length - 1];
      if (!frame) fail(`Unexpected closing tag ${tag}`, start);
      if (tag !== `/${frame.node.kind}`) fail(`Mismatched closing tag ${tag}; expected /${frame.node.kind}`, start);
      stack.pop();
      current = frame.parent;
    } else {
      current.push({ kind: 'value', path: pathTag(tag, start), raw, offset: start });
    }
  }
  if (stack.length) {
    const frame = stack[stack.length - 1];
    fail(`Unclosed ${frame.node.kind} block`, frame.node.offset);
  }

  function scalar(value: unknown, node: Extract<Node, { kind: 'value' }>): string {
    if (value == null) return '';
    if (typeof value === 'object' || typeof value === 'function') {
      fail(`Cannot render non-scalar value at path ${JSON.stringify(node.path)}`, node.offset);
    }
    const text = String(value);
    return node.raw ? text : text.replace(/[&<>"']/g, char => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[char]!);
  }

  function visit(list: Node[], context: Context): string {
    let output = '';
    for (const node of list) {
      if (node.kind === 'text') { output += node.text; continue; }
      const value = resolve(node.path, context);
      if (node.kind === 'value') output += scalar(value, node);
      else if (node.kind === 'if') output += visit(truthy(value) ? node.body : node.alternate, context);
      else if (Array.isArray(value) && value.length > 0) {
        for (let index = 0; index < value.length; index++) {
          output += visit(node.body, { root: context.root, item: value[index], index });
        }
      } else output += visit(node.alternate, context);
    }
    return output;
  }
  return visit(nodes, { root: data, item: data });
}

function truthy(value: unknown): boolean {
  return value !== '' && value !== 0 && value !== false && value != null
    && (!Array.isArray(value) || value.length > 0);
}

function lookup(value: unknown, parts: string[]): { found: boolean; value: unknown } {
  for (const part of parts) {
    if (value == null || !Object.prototype.hasOwnProperty.call(value, part)) {
      return { found: false, value: undefined };
    }
    value = (Object(value) as Record<string, unknown>)[part];
  }
  return { found: true, value };
}

function resolve(path: string, context: Context): unknown {
  const parts = path.split('.');
  if (parts[0] === 'this') return lookup(context.item, parts.slice(1)).value;
  if (parts[0] === '@index') return lookup(context.index, parts.slice(1)).value;
  const local = lookup(context.item, parts);
  return local.found ? local.value : lookup(context.root, parts).value;
}
