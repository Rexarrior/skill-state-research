type TextNode = { kind: "text"; text: string };
type ValueNode = { kind: "value"; path: string; raw: boolean; offset: number };
type BlockNode = {
  kind: "if" | "each";
  path: string;
  offset: number;
  body: Node[];
  alternate: Node[];
};
type Node = TextNode | ValueNode | BlockNode;
type Context = { root: unknown; item?: unknown; index?: number };
const missing = Symbol("missing");

/** Render a template, throwing a located error for invalid syntax or values. */
export function render(template: string, data: unknown): string {
  const lineStarts = [0];
  for (let i = 0; i < template.length; i++) {
    if (template[i] === "\n") lineStarts.push(i + 1);
  }
  function fail(message: string, offset: number): never {
    let low = 0;
    let high = lineStarts.length;
    while (low + 1 < high) {
      const middle = Math.floor((low + high) / 2);
      if (lineStarts[middle] <= offset) low = middle;
      else high = middle;
    }
    throw new Error(`${message} at line ${low + 1}, column ${offset - lineStarts[low] + 1}`);
  }
  function validatePath(path: string, offset: number): void {
    if (!/^(?:@index|[^\s.{}#\/!@]+(?:\.[^\s.{}#\/!@]+)*)$/.test(path)) {
      fail(`Invalid path ${JSON.stringify(path)}`, offset);
    }
  }

  const nodes: Node[] = [];
  const stack: { block: BlockNode; parent: Node[]; hasElse: boolean }[] = [];
  let target = nodes;
  let cursor = 0;
  while (cursor < template.length) {
    const start = template.indexOf("{{", cursor);
    if (start < 0) {
      target.push({ kind: "text", text: template.slice(cursor) });
      break;
    }
    if (start > cursor) target.push({ kind: "text", text: template.slice(cursor, start) });
    const raw = template.startsWith("{{{", start);
    const openingLength = raw ? 3 : 2;
    const end = template.indexOf(raw ? "}}}" : "}}", start + openingLength);
    if (end < 0) fail("Unclosed tag", start);
    const tag = template.slice(start + openingLength, end).trim();
    cursor = end + openingLength;
    if (!raw && tag.startsWith("!")) continue;
    if (!raw && tag.startsWith("#")) {
      const match = /^#(\S+)(?:\s+(.+))?$/.exec(tag);
      const kind = match?.[1];
      if (kind !== "if" && kind !== "each") fail(`Unknown block ${JSON.stringify(kind ?? tag)}`, start);
      const path = match?.[2] ?? "";
      validatePath(path, start);
      const block: BlockNode = { kind, path, offset: start, body: [], alternate: [] };
      target.push(block);
      stack.push({ block, parent: target, hasElse: false });
      target = block.body;
    } else if (!raw && tag === "else") {
      const frame = stack[stack.length - 1];
      if (!frame) fail("else outside a block", start);
      if (frame.hasElse) fail("Duplicate else", start);
      frame.hasElse = true;
      target = frame.block.alternate;
    } else if (!raw && tag.startsWith("/")) {
      const frame = stack[stack.length - 1];
      if (!frame) fail(`Unexpected closing tag ${tag}`, start);
      if (tag !== `/${frame.block.kind}`) fail(`Mismatched closing tag ${tag}; expected /${frame.block.kind}`, start);
      stack.pop();
      target = frame.parent;
    } else {
      validatePath(tag, start);
      target.push({ kind: "value", path: tag, raw, offset: start });
    }
  }
  if (stack.length) {
    const block = stack[stack.length - 1].block;
    fail(`Unclosed ${block.kind} block`, block.offset);
  }

  function visit(list: Node[], context: Context): string {
    const output: string[] = [];
    for (const node of list) {
      if (node.kind === "text") {
        output.push(node.text);
        continue;
      }
      const value = resolve(node.path, context);
      if (node.kind === "value") {
        if (value === missing || value == null) continue;
        if (typeof value === "object" || typeof value === "function") {
          fail(`Cannot render non-scalar value at path ${JSON.stringify(node.path)}`, node.offset);
        }
        const text = String(value);
        output.push(node.raw ? text : escapeHtml(text));
      } else if (node.kind === "if") {
        const truthy = value !== missing && !!value && (!Array.isArray(value) || value.length > 0);
        output.push(visit(truthy ? node.body : node.alternate, context));
      } else if (Array.isArray(value) && value.length > 0) {
        for (let index = 0; index < value.length; index++) {
          output.push(visit(node.body, { root: context.root, item: value[index], index }));
        }
      } else {
        output.push(visit(node.alternate, context));
      }
    }
    return output.join("");
  }
  return visit(nodes, { root: data });
}

function lookup(value: unknown, parts: string[]): unknown {
  for (const part of parts) {
    if (value == null || !Object.prototype.hasOwnProperty.call(value, part)) return missing;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

function resolve(path: string, context: Context): unknown {
  if (path === "@index") return context.index;
  const parts = path.split(".");
  if (parts[0] === "this") {
    return lookup(context.index === undefined ? context.root : context.item, parts.slice(1));
  }
  if (context.index !== undefined) {
    const local = lookup(context.item, parts);
    if (local !== missing) return local;
  }
  return lookup(context.root, parts);
}

function escapeHtml(text: string): string {
  const escapes: Record<string, string> = {
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  };
  return text.replace(/[&<>"']/g, (character) => escapes[character]);
}
