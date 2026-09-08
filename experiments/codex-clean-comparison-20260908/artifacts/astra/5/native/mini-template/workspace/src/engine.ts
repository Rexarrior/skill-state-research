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
type Context = { root: unknown; current: unknown; index?: number };

function diagnostics(template: string) {
  const starts = [0];
  for (let i = 0; i < template.length; i++) {
    if (template[i] === "\n") starts.push(i + 1);
  }
  return (message: string, offset: number): never => {
    let low = 0;
    let high = starts.length;
    while (low + 1 < high) {
      const mid = (low + high) >>> 1;
      if (starts[mid]! <= offset) low = mid;
      else high = mid;
    }
    throw new Error(`${message} at line ${low + 1}, column ${offset - starts[low]! + 1}`);
  };
}

function parse(template: string, fail: ReturnType<typeof diagnostics>): Node[] {
  const nodes: Node[] = [];
  const stack: { node: BlockNode; parent: Node[]; hasElse: boolean }[] = [];
  let target = nodes;
  let cursor = 0;
  const checkPath = (path: string, offset: number) => {
    if (!path || /\s|[{}]/u.test(path) || path.split(".").some(part => !part)) {
      fail(`Invalid path ${JSON.stringify(path)}`, offset);
    }
  };

  while (cursor < template.length) {
    const start = template.indexOf("{{", cursor);
    if (start === -1) {
      target.push({ kind: "text", value: template.slice(cursor) });
      break;
    }
    if (start > cursor) target.push({ kind: "text", value: template.slice(cursor, start) });
    const raw = template.startsWith("{{{", start);
    const closing = raw ? "}}}" : "}}";
    const end = template.indexOf(closing, start + (raw ? 3 : 2));
    if (end === -1) fail("Unclosed tag", start);
    const tag = template.slice(start + (raw ? 3 : 2), end).trim();
    cursor = end + closing.length;

    if (!raw && tag.startsWith("!")) continue;
    if (!raw && tag.startsWith("#")) {
      const match = /^#(\S+)(?:\s+([\s\S]*))?$/u.exec(tag);
      const kind = match?.[1];
      if (kind !== "if" && kind !== "each") fail(`Unknown block ${JSON.stringify(kind ?? tag)}`, start);
      const path = match?.[2]?.trim() ?? "";
      checkPath(path, start);
      const node: BlockNode = { kind, path, body: [], alternate: [], offset: start };
      target.push(node);
      stack.push({ node, parent: target, hasElse: false });
      target = node.body;
    } else if (!raw && tag === "else") {
      const frame = stack[stack.length - 1];
      if (!frame) fail("else outside a block", start);
      if (frame.hasElse) fail("Duplicate else", start);
      frame.hasElse = true;
      target = frame.node.alternate;
    } else if (!raw && tag.startsWith("/")) {
      const frame = stack[stack.length - 1];
      if (!frame) fail(`Unexpected closing tag ${JSON.stringify(tag)}`, start);
      if (tag !== `/${frame.node.kind}`) {
        fail(`Mismatched closing tag ${JSON.stringify(tag)}; expected /${frame.node.kind}`, start);
      }
      stack.pop();
      target = frame.parent;
    } else {
      checkPath(tag, start);
      target.push({ kind: "value", path: tag, raw, offset: start });
    }
  }
  const frame = stack[stack.length - 1];
  if (frame) fail(`Unclosed ${frame.node.kind} block`, frame.node.offset);
  return nodes;
}

const missing = Symbol("missing");

function lookup(value: unknown, parts: string[]): unknown | typeof missing {
  for (const part of parts) {
    if (value == null || !Object.prototype.hasOwnProperty.call(value, part)) return missing;
    value = (Object(value) as Record<string, unknown>)[part];
  }
  return value;
}

function resolve(path: string, context: Context): unknown {
  if (path === "@index") return context.index;
  if (path === "this") return context.current;
  if (path.startsWith("this.")) {
    const value = lookup(context.current, path.slice(5).split("."));
    return value === missing ? undefined : value;
  }
  const parts = path.split(".");
  const local = lookup(context.current, parts);
  if (local !== missing) return local;
  const root = lookup(context.root, parts);
  return root === missing ? undefined : root;
}

function truthy(value: unknown): boolean {
  return Array.isArray(value) ? value.length > 0 : Boolean(value);
}

const escapes: Record<string, string> = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
};

/** Render a template using own-property paths and HTML-escaped interpolation. */
export function render(template: string, data: unknown): string {
  const fail = diagnostics(template);
  const nodes = parse(template, fail);
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
        if (typeof value === "object" || typeof value === "function" || typeof value === "symbol") {
          fail(`Cannot render non-scalar value for ${JSON.stringify(node.path)}`, node.offset);
        }
        const text = String(value);
        output.push(node.raw ? text : text.replace(/[&<>"']/g, character => escapes[character]!));
      } else if (node.kind === "if") {
        visit(truthy(value) ? node.body : node.alternate, context);
      } else if (Array.isArray(value) && value.length > 0) {
        for (let index = 0; index < value.length; index++) {
          visit(node.body, { root: context.root, current: value[index], index });
        }
      } else {
        visit(node.alternate, context);
      }
    }
  }
  visit(nodes, { root: data, current: data });
  return output.join("");
}
