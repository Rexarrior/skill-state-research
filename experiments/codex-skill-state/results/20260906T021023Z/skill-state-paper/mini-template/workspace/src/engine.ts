type TextNode = { kind: "text"; value: string };
type ValueNode = { kind: "value"; path: string; escaped: boolean; offset: number };
type BlockNode = {
  kind: "if" | "each";
  path: string;
  body: Node[];
  alternate: Node[];
  offset: number;
  hasElse: boolean;
};
type Node = TextNode | ValueNode | BlockNode;

type Frame = { node: BlockNode; parent: Node[] };
type Context = { root: unknown; current: unknown; inEach: boolean; index?: number };

function position(source: string, offset: number): string {
  const before = source.slice(0, offset);
  const line = before.split("\n").length;
  const lastNewline = before.lastIndexOf("\n");
  return `line ${line}, column ${offset - lastNewline}`;
}

function syntaxError(source: string, offset: number, message: string): never {
  throw new Error(`${message} at ${position(source, offset)}`);
}

function parse(source: string): Node[] {
  const root: Node[] = [];
  const stack: Frame[] = [];
  let output = root;
  let cursor = 0;

  while (cursor < source.length) {
    const open = source.indexOf("{{", cursor);
    if (open === -1) {
      output.push({ kind: "text", value: source.slice(cursor) });
      break;
    }
    if (open > cursor) output.push({ kind: "text", value: source.slice(cursor, open) });

    const triple = source.startsWith("{{{", open);
    const closeToken = triple ? "}}}" : "}}";
    const contentStart = open + (triple ? 3 : 2);
    const close = source.indexOf(closeToken, contentStart);
    if (close === -1) syntaxError(source, open, "Unclosed tag");

    const tag = source.slice(contentStart, close).trim();
    cursor = close + closeToken.length;

    if (triple) {
      output.push({ kind: "value", path: tag, escaped: false, offset: open });
      continue;
    }
    if (tag.startsWith("!")) continue;

    if (tag.startsWith("#")) {
      const match = /^#(if|each)(?:\s+(.+))$/.exec(tag);
      if (!match) syntaxError(source, open, `Unknown or malformed block '${tag}'`);
      const node: BlockNode = {
        kind: match[1] as "if" | "each",
        path: match[2].trim(),
        body: [],
        alternate: [],
        offset: open,
        hasElse: false,
      };
      output.push(node);
      stack.push({ node, parent: output });
      output = node.body;
      continue;
    }

    if (tag === "else") {
      const frame = stack.at(-1);
      if (!frame) syntaxError(source, open, "'else' outside a block");
      if (frame.node.hasElse) syntaxError(source, open, "Duplicate 'else'");
      frame.node.hasElse = true;
      output = frame.node.alternate;
      continue;
    }

    if (tag.startsWith("/")) {
      const name = tag.slice(1).trim();
      const frame = stack.at(-1);
      if (!frame) syntaxError(source, open, `Unexpected closing block '${name}'`);
      if (name !== frame.node.kind) {
        syntaxError(source, open, `Mismatched closing block '${name}'; expected '${frame.node.kind}'`);
      }
      stack.pop();
      output = frame.parent;
      continue;
    }

    output.push({ kind: "value", path: tag, escaped: true, offset: open });
  }

  const unclosed = stack.at(-1);
  if (unclosed) syntaxError(source, unclosed.node.offset, `Unclosed '${unclosed.node.kind}' block`);
  return root;
}

function property(value: unknown, parts: string[]): { found: boolean; value: unknown } {
  let cursor = value;
  for (const part of parts) {
    if ((typeof cursor !== "object" && typeof cursor !== "function") || cursor === null) {
      return { found: false, value: undefined };
    }
    if (!Object.prototype.hasOwnProperty.call(cursor, part)) return { found: false, value: undefined };
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return { found: true, value: cursor };
}

function resolve(path: string, context: Context): unknown {
  if (path === "this") return context.inEach ? context.current : context.root;
  if (path === "@index") return context.inEach ? context.index : undefined;
  if (!path) return undefined;
  const parts = path.split(".");
  if (context.inEach) {
    const local = property(context.current, parts);
    if (local.found) return local.value;
  }
  return property(context.root, parts).value;
}

function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return !(value === "" || value === 0 || value === false || value == null);
}

function scalar(value: unknown, source: string, offset: number): string {
  if (value == null) return "";
  switch (typeof value) {
    case "string":
      return value;
    case "number":
    case "bigint":
    case "boolean":
      return String(value);
    default:
      throw new Error(`Cannot render ${typeof value} as scalar text at ${position(source, offset)}`);
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]!);
}

function renderNodes(nodes: Node[], context: Context, source: string): string {
  let result = "";
  for (const node of nodes) {
    if (node.kind === "text") {
      result += node.value;
    } else if (node.kind === "value") {
      const value = scalar(resolve(node.path, context), source, node.offset);
      result += node.escaped ? escapeHtml(value) : value;
    } else if (node.kind === "if") {
      const branch = truthy(resolve(node.path, context)) ? node.body : node.alternate;
      result += renderNodes(branch, context, source);
    } else {
      const value = resolve(node.path, context);
      if (Array.isArray(value) && value.length > 0) {
        for (let index = 0; index < value.length; index++) {
          result += renderNodes(node.body, {
            root: context.root,
            current: value[index],
            inEach: true,
            index,
          }, source);
        }
      } else {
        result += renderNodes(node.alternate, context, source);
      }
    }
  }
  return result;
}

export function render(template: string, data: unknown): string {
  return renderNodes(parse(template), { root: data, current: data, inEach: false }, template);
}
