type TextNode = { kind: "text"; value: string };
type ValueNode = { kind: "value"; path: string; raw: boolean; offset: number };
type BlockNode = {
  kind: "if" | "each";
  path: string;
  body: Node[];
  otherwise: Node[];
  offset: number;
};
type Node = TextNode | ValueNode | BlockNode;
type Context = { root: unknown; item: unknown; index?: number };

function fail(template: string, offset: number, message: string): never {
  const before = template.slice(0, offset);
  const line = before.split("\n").length;
  const column = offset - before.lastIndexOf("\n");
  throw new Error(`${message} at line ${line}, column ${column}`);
}

function validatePath(template: string, path: string, offset: number): void {
  if (!/^(?:@index|[^\s.{}#/!@]+(?:\.[^\s.{}#/!@]+)*)$/.test(path)) {
    fail(template, offset, `Invalid path ${JSON.stringify(path)}`);
  }
}

function parse(template: string): Node[] {
  const nodes: Node[] = [];
  const stack: { node: BlockNode; parent: Node[]; hasElse: boolean }[] = [];
  let target = nodes;
  let cursor = 0;
  while (cursor < template.length) {
    const start = template.indexOf("{{", cursor);
    if (start === -1) {
      target.push({ kind: "text", value: template.slice(cursor) });
      break;
    }
    if (start > cursor) target.push({ kind: "text", value: template.slice(cursor, start) });
    const raw = template.startsWith("{{{", start);
    const openingLength = raw ? 3 : 2;
    const closing = raw ? "}}}" : "}}";
    const end = template.indexOf(closing, start + openingLength);
    if (end === -1) fail(template, start, "Unclosed tag");
    const tag = template.slice(start + openingLength, end).trim();
    cursor = end + closing.length;

    if (!raw && tag.startsWith("!")) continue;
    if (!raw && tag.startsWith("#")) {
      const match = /^#(\S+)(?:\s+([\s\S]*))?$/.exec(tag);
      const kind = match?.[1];
      if (kind !== "if" && kind !== "each") fail(template, start, `Unknown block ${JSON.stringify(kind ?? tag)}`);
      const path = match?.[2]?.trim() ?? "";
      validatePath(template, path, start);
      const node: BlockNode = { kind, path, body: [], otherwise: [], offset: start };
      target.push(node);
      stack.push({ node, parent: target, hasElse: false });
      target = node.body;
    } else if (!raw && tag === "else") {
      const frame = stack.at(-1);
      if (!frame) fail(template, start, "else outside a block");
      if (frame.hasElse) fail(template, start, "Duplicate else");
      frame.hasElse = true;
      target = frame.node.otherwise;
    } else if (!raw && tag.startsWith("/")) {
      const frame = stack.at(-1);
      if (!frame) fail(template, start, `Unexpected closing tag ${tag}`);
      if (tag !== `/${frame.node.kind}`) {
        fail(template, start, `Mismatched closing tag ${tag}; expected /${frame.node.kind}`);
      }
      stack.pop();
      target = frame.parent;
    } else {
      validatePath(template, tag, start);
      target.push({ kind: "value", path: tag, raw, offset: start });
    }
  }
  const unclosed = stack.at(-1);
  if (unclosed) fail(template, unclosed.node.offset, `Unclosed ${unclosed.node.kind} block`);
  return nodes;
}

// Only own properties participate in lookup; prototype properties are not data.
function lookup(value: unknown, parts: string[]): { found: boolean; value: unknown } {
  for (const part of parts) {
    if (value == null || !Object.prototype.hasOwnProperty.call(value, part)) {
      return { found: false, value: undefined };
    }
    value = (value as Record<string, unknown>)[part];
  }
  return { found: true, value };
}

function resolve(path: string, context: Context): unknown {
  if (path === "@index") return context.index;
  if (path === "this") return context.item;
  const parts = path.split(".");
  if (parts[0] === "this") return lookup(context.item, parts.slice(1)).value;
  const local = lookup(context.item, parts);
  return local.found ? local.value : lookup(context.root, parts).value;
}

function truthy(value: unknown): boolean {
  return Array.isArray(value) ? value.length > 0 : Boolean(value);
}

const escapes: Record<string, string> = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
};

/** Render a template using own-property paths, with HTML escaping by default. */
export function render(template: string, data: unknown): string {
  const nodes = parse(template);
  const output: string[] = [];
  function visit(nodes: Node[], context: Context): void {
    for (const node of nodes) {
      if (node.kind === "text") {
        output.push(node.value);
        continue;
      }
      const value = resolve(node.path, context);
      if (node.kind === "value") {
        if (value == null) continue;
        if (typeof value === "object" || typeof value === "function") {
          fail(template, node.offset, `Cannot render ${JSON.stringify(node.path)} as scalar text (${Array.isArray(value) ? "array" : typeof value})`);
        }
        const text = String(value);
        output.push(node.raw ? text : text.replace(/[&<>"']/g, (char) => escapes[char]!));
      } else if (node.kind === "if") {
        visit(truthy(value) ? node.body : node.otherwise, context);
      } else if (Array.isArray(value) && value.length > 0) {
        for (let index = 0; index < value.length; index++) {
          visit(node.body, { root: context.root, item: value[index], index });
        }
      } else {
        visit(node.otherwise, context);
      }
    }
  }
  visit(nodes, { root: data, item: data });
  return output.join("");
}
