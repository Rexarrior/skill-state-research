type Position = { line: number; column: number };

type Node =
  | { type: "text"; value: string }
  | { type: "value"; path: string; escaped: boolean; position: Position }
  | {
      type: "block";
      kind: "if" | "each";
      path: string;
      truthy: Node[];
      falsy: Node[];
      position: Position;
    };

type BlockNode = Extract<Node, { type: "block" }>;

type Frame = {
  node: BlockNode;
  parent: Node[];
  inElse: boolean;
};

function positionAt(source: string, offset: number): Position {
  let line = 1;
  let column = 1;
  for (let i = 0; i < offset; i++) {
    if (source.charCodeAt(i) === 10) {
      line++;
      column = 1;
    } else {
      column++;
    }
  }
  return { line, column };
}

function fail(message: string, position: Position): never {
  throw new Error(`${message} at line ${position.line}, column ${position.column}`);
}

function validPath(path: string): boolean {
  return (
    path === "this" ||
    path === "@index" ||
    /^(?:this\.)?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(path)
  );
}

function parse(source: string): Node[] {
  const root: Node[] = [];
  const stack: Frame[] = [];
  let output = root;
  let cursor = 0;

  while (cursor < source.length) {
    const start = source.indexOf("{{", cursor);
    if (start === -1) {
      output.push({ type: "text", value: source.slice(cursor) });
      break;
    }
    if (start > cursor) output.push({ type: "text", value: source.slice(cursor, start) });

    const triple = source.startsWith("{{{", start);
    const close = triple ? "}}}" : "}}";
    const contentStart = start + (triple ? 3 : 2);
    const end = source.indexOf(close, contentStart);
    const position = positionAt(source, start);
    if (end === -1) fail("Unclosed tag", position);

    const tag = source.slice(contentStart, end).trim();
    cursor = end + close.length;

    if (triple) {
      if (!tag || !validPath(tag)) fail(`Invalid interpolation path '${tag}'`, position);
      output.push({ type: "value", path: tag, escaped: false, position });
      continue;
    }

    if (tag.startsWith("!")) continue;

    if (tag === "else") {
      const frame = stack.at(-1);
      if (!frame) fail("'else' outside a block", position);
      if (frame.inElse) fail("Duplicate 'else'", position);
      frame.inElse = true;
      output = frame.node.falsy;
      continue;
    }

    if (tag.startsWith("#")) {
      const match = /^#(if|each)\s+(.+)$/.exec(tag);
      if (!match) fail(`Unknown or malformed block '${tag}'`, position);
      const kind = match[1] as "if" | "each";
      const path = match[2].trim();
      if (!validPath(path)) fail(`Invalid block path '${path}'`, position);
      const node: BlockNode = {
        type: "block",
        kind,
        path,
        truthy: [],
        falsy: [],
        position,
      };
      output.push(node);
      stack.push({ node, parent: output, inElse: false });
      output = node.truthy;
      continue;
    }

    if (tag.startsWith("/")) {
      const name = tag.slice(1).trim();
      if (name !== "if" && name !== "each") fail(`Unknown closing block '${tag}'`, position);
      const frame = stack.at(-1);
      if (!frame) fail(`Closing '${name}' without an open block`, position);
      if (frame.node.kind !== name) {
        fail(`Mismatched closing block: expected '/${frame.node.kind}', got '/${name}'`, position);
      }
      stack.pop();
      output = frame.parent;
      continue;
    }

    if (!tag || !validPath(tag)) fail(`Invalid interpolation path '${tag}'`, position);
    output.push({ type: "value", path: tag, escaped: true, position });
  }

  const unclosed = stack.at(-1);
  if (unclosed) fail(`Unclosed '${unclosed.node.kind}' block`, unclosed.node.position);
  return root;
}

type Context = { root: unknown; current: unknown; index: number | undefined };

function property(value: unknown, key: string): unknown {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "object" && typeof value !== "function") return undefined;
  return (value as Record<string, unknown>)[key];
}

function resolve(path: string, context: Context): unknown {
  if (path === "@index") return context.index;
  if (path === "this") return context.current;

  const fromCurrent = path.startsWith("this.");
  const parts = (fromCurrent ? path.slice(5) : path).split(".");
  let value = fromCurrent ? context.current : context.root;
  for (const part of parts) value = property(value, part);
  return value;
}

function scalar(value: unknown, path: string, position: Position): string {
  if (value === null || value === undefined) return "";
  switch (typeof value) {
    case "string":
      return value;
    case "number":
    case "bigint":
    case "boolean":
      return String(value);
    default:
      fail(`Value at '${path}' cannot be rendered as scalar text`, position);
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      default: return "&#39;";
    }
  });
}

function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return value !== "" && value !== 0 && value !== false && value !== null && value !== undefined;
}

function renderNodes(nodes: Node[], context: Context): string {
  let result = "";
  for (const node of nodes) {
    if (node.type === "text") {
      result += node.value;
    } else if (node.type === "value") {
      const text = scalar(resolve(node.path, context), node.path, node.position);
      result += node.escaped ? escapeHtml(text) : text;
    } else {
      const value = resolve(node.path, context);
      if (node.kind === "if") {
        result += renderNodes(truthy(value) ? node.truthy : node.falsy, context);
      } else if (Array.isArray(value) && value.length > 0) {
        for (let index = 0; index < value.length; index++) {
          result += renderNodes(node.truthy, {
            root: context.root,
            current: value[index],
            index,
          });
        }
      } else {
        result += renderNodes(node.falsy, context);
      }
    }
  }
  return result;
}

/** Render a Mini Template string using the supplied root data value. */
export function render(template: string, data: unknown): string {
  return renderNodes(parse(template), { root: data, current: data, index: undefined });
}
