type Node = TextNode | ValueNode | BlockNode;

interface TextNode {
  kind: "text";
  value: string;
}

interface ValueNode {
  kind: "value";
  path: string;
  escaped: boolean;
  offset: number;
}

interface BlockNode {
  kind: "if" | "each";
  path: string;
  body: Node[];
  alternate: Node[];
  offset: number;
}

interface Frame {
  block: BlockNode;
  parent: Node[];
  inAlternate: boolean;
}

interface Context {
  value: unknown;
  index: number | undefined;
}

const MISSING = Symbol("missing");

/** Render a Mini Template string with the supplied data. */
export function render(template: string, data: unknown): string {
  const nodes = parse(template);
  return renderNodes(nodes, data, undefined, data);
}

function parse(template: string): Node[] {
  const root: Node[] = [];
  let current = root;
  const stack: Frame[] = [];
  let cursor = 0;

  while (cursor < template.length) {
    const start = template.indexOf("{{", cursor);
    if (start === -1) {
      current.push({ kind: "text", value: template.slice(cursor) });
      break;
    }
    if (start > cursor) {
      current.push({ kind: "text", value: template.slice(cursor, start) });
    }

    const triple = template.startsWith("{{{", start);
    const closing = triple ? "}}}" : "}}";
    const contentStart = start + (triple ? 3 : 2);
    const end = template.indexOf(closing, contentStart);
    if (end === -1) {
      fail(template, start, `Unclosed ${triple ? "triple " : ""}tag`);
    }

    const tag = template.slice(contentStart, end).trim();
    cursor = end + closing.length;

    if (triple) {
      current.push({ kind: "value", path: tag, escaped: false, offset: start });
      continue;
    }
    if (tag.startsWith("!")) continue;

    if (tag === "else") {
      const frame = stack.at(-1);
      if (!frame) fail(template, start, "'else' outside a block");
      if (frame.inAlternate) fail(template, start, "Duplicate 'else'");
      frame.inAlternate = true;
      current = frame.block.alternate;
      continue;
    }

    if (tag.startsWith("#")) {
      const match = /^#(if|each)\s+(.+)$/.exec(tag);
      if (!match) {
        const name = tag.slice(1).trim().split(/\s+/, 1)[0] || "(empty)";
        fail(template, start, `Unknown or malformed block '${name}'`);
      }
      const block: BlockNode = {
        kind: match[1] as "if" | "each",
        path: match[2].trim(),
        body: [],
        alternate: [],
        offset: start,
      };
      current.push(block);
      stack.push({ block, parent: current, inAlternate: false });
      current = block.body;
      continue;
    }

    if (tag.startsWith("/")) {
      const name = tag.slice(1).trim();
      const frame = stack.at(-1);
      if (!frame) fail(template, start, `Closing '${name}' without an open block`);
      if (name !== frame.block.kind) {
        fail(template, start, `Mismatched closing block: expected '/${frame.block.kind}', got '/${name}'`);
      }
      stack.pop();
      current = frame.parent;
      continue;
    }

    current.push({ kind: "value", path: tag, escaped: true, offset: start });
  }

  const unclosed = stack.at(-1);
  if (unclosed) fail(template, unclosed.block.offset, `Unclosed '${unclosed.block.kind}' block`);
  return root;
}

function renderNodes(nodes: Node[], current: unknown, index: number | undefined, root: unknown): string {
  let output = "";
  const context: Context = { value: current, index };

  for (const node of nodes) {
    if (node.kind === "text") {
      output += node.value;
      continue;
    }

    const resolved = resolve(node.path, context, root);
    const value = resolved === MISSING ? undefined : resolved;
    if (node.kind === "value") {
      const text = scalar(value, node.path);
      output += node.escaped ? escapeHtml(text) : text;
    } else if (node.kind === "if") {
      output += renderNodes(isTruthy(value) ? node.body : node.alternate, current, index, root);
    } else if (Array.isArray(value) && value.length > 0) {
      for (let itemIndex = 0; itemIndex < value.length; itemIndex++) {
        output += renderNodes(node.body, value[itemIndex], itemIndex, root);
      }
    } else {
      output += renderNodes(node.alternate, current, index, root);
    }
  }
  return output;
}

function resolve(path: string, context: Context, root: unknown): unknown | typeof MISSING {
  if (path === "this") return context.value;
  if (path === "@index") return context.index === undefined ? MISSING : context.index;

  if (path.startsWith("this.")) return descend(context.value, path.slice(5).split("."));
  const parts = path.split(".");
  const local = descend(context.value, parts);
  return local === MISSING ? descend(root, parts) : local;
}

function descend(value: unknown, parts: string[]): unknown | typeof MISSING {
  let cursor = value;
  for (const part of parts) {
    if (!part || (typeof cursor !== "object" && typeof cursor !== "function") || cursor === null) {
      return MISSING;
    }
    if (!(part in cursor)) return MISSING;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

function scalar(value: unknown, path: string): string {
  if (value === null || value === undefined) return "";
  switch (typeof value) {
    case "string": return value;
    case "number":
    case "bigint":
    case "boolean": return String(value);
    default: throw new Error(`Cannot render '${path}' as scalar text (received ${kindOf(value)})`);
  }
}

function kindOf(value: unknown): string {
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function isTruthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return value !== "" && value !== 0 && value !== false && value !== null && value !== undefined;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[character]!);
}

function fail(template: string, offset: number, message: string): never {
  let line = 1;
  let column = 1;
  for (let i = 0; i < offset; i++) {
    if (template.charCodeAt(i) === 10) {
      line++;
      column = 1;
    } else {
      column++;
    }
  }
  throw new Error(`${message} at line ${line}, column ${column}`);
}
