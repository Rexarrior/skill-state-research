type TextNode = { kind: "text"; value: string };
type ValueNode = { kind: "value"; path: string; raw: boolean; at: number };
type BlockNode = {
  kind: "if" | "each";
  path: string;
  yes: Node[];
  no: Node[];
  at: number;
};
type Node = TextNode | ValueNode | BlockNode;
type Context = { root: unknown; item?: unknown; index?: number };

function fail(template: string, at: number, message: string): never {
  const before = template.slice(0, at);
  const line = before.split("\n").length;
  const column = at - before.lastIndexOf("\n");
  throw new Error(`${message} at line ${line}, column ${column}`);
}

function parse(template: string): Node[] {
  const nodes: Node[] = [];
  const stack: { block: BlockNode; parent: Node[]; hasElse: boolean }[] = [];
  let target = nodes;
  let cursor = 0;
  while (cursor < template.length) {
    const at = template.indexOf("{{", cursor);
    if (at < 0) {
      target.push({ kind: "text", value: template.slice(cursor) });
      break;
    }
    if (at > cursor) target.push({ kind: "text", value: template.slice(cursor, at) });
    const raw = template.startsWith("{{{", at);
    const end = template.indexOf(raw ? "}}}" : "}}", at + (raw ? 3 : 2));
    if (end < 0) fail(template, at, "Unclosed tag");
    const tag = template.slice(at + (raw ? 3 : 2), end).trim();
    cursor = end + (raw ? 3 : 2);
    if (!raw && tag.startsWith("!")) continue;
    if (!raw && tag.startsWith("#")) {
      const match = /^#(if|each)\s+(.+)$/.exec(tag);
      if (!match) fail(template, at, `Unknown or invalid block '${tag}'`);
      const block: BlockNode = {
        kind: match[1] as "if" | "each", path: match[2].trim(), yes: [], no: [], at,
      };
      target.push(block);
      stack.push({ block, parent: target, hasElse: false });
      target = block.yes;
    } else if (!raw && tag === "else") {
      const frame = stack[stack.length - 1];
      if (!frame) fail(template, at, "else outside a block");
      if (frame.hasElse) fail(template, at, "Duplicate else");
      frame.hasElse = true;
      target = frame.block.no;
    } else if (!raw && tag.startsWith("/")) {
      const frame = stack[stack.length - 1];
      if (!frame) fail(template, at, `Unexpected closing tag '${tag}'`);
      if (tag !== `/${frame.block.kind}`) {
        fail(template, at, `Mismatched closing tag '${tag}'; expected '/${frame.block.kind}'`);
      }
      stack.pop();
      target = frame.parent;
    } else {
      if (!tag) fail(template, at, "Empty interpolation");
      target.push({ kind: "value", path: tag, raw, at });
    }
  }
  if (stack.length) {
    const { block } = stack[stack.length - 1];
    fail(template, block.at, `Unclosed '${block.kind}' block`);
  }
  return nodes;
}

const missing = Symbol("missing");

function lookup(value: unknown, parts: string[]): unknown {
  for (const part of parts) {
    if (value == null || !Object.prototype.hasOwnProperty.call(value, part)) return missing;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

function resolve(path: string, context: Context): unknown {
  const parts = path.split(".");
  if (parts[0] === "@index") return lookup(context.index, parts.slice(1));
  if (parts[0] === "this") {
    return lookup(context.index === undefined ? context.root : context.item, parts.slice(1));
  }
  if (context.index !== undefined) {
    const local = lookup(context.item, parts);
    if (local !== missing) return local;
  }
  return lookup(context.root, parts);
}

function truthy(value: unknown): boolean {
  return value !== missing && value !== undefined && value !== null &&
    value !== "" && value !== 0 && value !== false &&
    (!Array.isArray(value) || value.length > 0);
}

const escapes: Record<string, string> = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
};

/** Render a template using own-property dotted paths and HTML escaping by default. */
export function render(template: string, data: unknown): string {
  const nodes = parse(template);
  const output: string[] = [];
  function visit(children: Node[], context: Context): void {
    for (const node of children) {
      if (node.kind === "text") {
        output.push(node.value);
      } else if (node.kind === "value") {
        const value = resolve(node.path, context);
        if (value === missing || value == null) continue;
        if (typeof value === "object" || typeof value === "function") {
          fail(template, node.at, `Cannot render '${node.path}': expected scalar text, received ${Array.isArray(value) ? "array" : typeof value}`);
        }
        const text = String(value);
        output.push(node.raw ? text : text.replace(/[&<>"']/g, (char) => escapes[char]));
      } else if (node.kind === "if") {
        visit(truthy(resolve(node.path, context)) ? node.yes : node.no, context);
      } else {
        const value = resolve(node.path, context);
        if (Array.isArray(value) && value.length) {
          for (let index = 0; index < value.length; index++) {
            visit(node.yes, { root: context.root, item: value[index], index });
          }
        } else {
          visit(node.no, context);
        }
      }
    }
  }
  visit(nodes, { root: data });
  return output.join("");
}
