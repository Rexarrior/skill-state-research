type TextNode = { kind: "text"; value: string };
type ValueNode = { kind: "value"; path: string; raw: boolean; offset: number };
type BlockNode = {
  kind: "if" | "each";
  path: string;
  body: Node[];
  alternate: Node[];
  offset: number;
};
type Node = TextNode | ValueNode | BlockNode;
type Frame = { block: BlockNode; inElse: boolean };
type Context = { root: unknown; item?: unknown; index?: number };

function fail(template: string, offset: number, message: string): never {
  const before = template.slice(0, offset);
  const line = before.split("\n").length;
  const column = offset - before.lastIndexOf("\n");
  throw new Error(`${message} at line ${line}, column ${column}`);
}

function validatePath(template: string, path: string, offset: number): void {
  if (!/^(?:@index|[^\s.{}#/!]+)(?:\.[^\s.{}#/!]+)*$/.test(path)) {
    fail(template, offset, `Invalid path ${JSON.stringify(path)}`);
  }
}

function parse(template: string): Node[] {
  const result: Node[] = [];
  const stack: Frame[] = [];
  const target = (): Node[] => {
    const frame = stack[stack.length - 1];
    return frame ? (frame.inElse ? frame.block.alternate : frame.block.body) : result;
  };
  let cursor = 0;
  while (cursor < template.length) {
    const start = template.indexOf("{{", cursor);
    if (start < 0) {
      target().push({ kind: "text", value: template.slice(cursor) });
      break;
    }
    if (start > cursor) target().push({ kind: "text", value: template.slice(cursor, start) });
    const raw = template.startsWith("{{{", start);
    const closing = raw ? "}}}" : "}}";
    const end = template.indexOf(closing, start + (raw ? 3 : 2));
    if (end < 0) fail(template, start, "Unclosed tag");
    const tag = template.slice(start + (raw ? 3 : 2), end).trim();
    cursor = end + closing.length;
    if (!raw && tag.startsWith("!")) continue;
    if (!raw && tag.startsWith("#")) {
      const match = /^#(\S+)(?:\s+(.+))?$/.exec(tag);
      const name = match?.[1];
      if (name !== "if" && name !== "each") fail(template, start, `Unknown block ${JSON.stringify(name ?? tag)}`);
      const path = match?.[2] ?? "";
      validatePath(template, path, start);
      const block: BlockNode = { kind: name, path, body: [], alternate: [], offset: start };
      target().push(block);
      stack.push({ block, inElse: false });
    } else if (!raw && tag === "else") {
      const frame = stack[stack.length - 1];
      if (!frame) fail(template, start, "else outside a block");
      if (frame.inElse) fail(template, start, "Duplicate else");
      frame.inElse = true;
    } else if (!raw && tag.startsWith("/")) {
      const frame = stack[stack.length - 1];
      if (!frame) fail(template, start, `Unexpected close ${tag}`);
      if (tag !== `/${frame.block.kind}`) fail(template, start, `Mismatched close ${tag}; expected /${frame.block.kind}`);
      stack.pop();
    } else {
      validatePath(template, tag, start);
      target().push({ kind: "value", path: tag, raw, offset: start });
    }
  }
  if (stack.length) {
    const { block } = stack[stack.length - 1];
    fail(template, block.offset, `Unclosed ${block.kind} block`);
  }
  return result;
}

const missing = Symbol("missing");
function lookup(value: unknown, parts: string[]): unknown {
  for (const part of parts) {
    if (value == null || !Object.prototype.hasOwnProperty.call(value, part)) return missing;
    value = (Object(value) as Record<string, unknown>)[part];
  }
  return value;
}

function resolve(path: string, context: Context): unknown {
  const parts = path.split(".");
  if (parts[0] === "this") return lookup(context.index === undefined ? context.root : context.item, parts.slice(1));
  if (parts[0] === "@index") return lookup(context.index, parts.slice(1));
  if (context.index !== undefined) {
    const local = lookup(context.item, parts);
    if (local !== missing) return local;
  }
  return lookup(context.root, parts);
}

function truthy(value: unknown): boolean {
  return value !== missing && Boolean(value) && (!Array.isArray(value) || value.length > 0);
}

const escapes: Record<string, string> = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
};

/** Render a template with escaped interpolation, conditionals, and array loops. */
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
      if (node.kind === "if") {
        visit(truthy(value) ? node.body : node.alternate, context);
      } else if (node.kind === "each") {
        if (Array.isArray(value) && value.length > 0) {
          for (let index = 0; index < value.length; index++) {
            visit(node.body, { root: context.root, item: value[index], index });
          }
        } else {
          visit(node.alternate, context);
        }
      } else {
        if (value === missing || value == null) continue;
        if (!["string", "number", "boolean", "bigint"].includes(typeof value)) {
          fail(template, node.offset, `Cannot render ${node.path} as scalar text (${Array.isArray(value) ? "array" : typeof value})`);
        }
        const text = String(value);
        output.push(node.raw ? text : text.replace(/[&<>"']/g, character => escapes[character]!));
      }
    }
  }
  visit(nodes, { root: data });
  return output.join("");
}
