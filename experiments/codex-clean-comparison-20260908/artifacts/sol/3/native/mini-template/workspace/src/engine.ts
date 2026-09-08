type Position = {
  index: number;
  line: number;
  column: number;
};

type TextNode = { type: "text"; value: string };
type ValueNode = { type: "value"; path: string; escaped: boolean; position: Position };
type IfNode = {
  type: "if";
  path: string;
  truthy: Node[];
  falsy: Node[];
  position: Position;
};
type EachNode = {
  type: "each";
  path: string;
  items: Node[];
  empty: Node[];
  position: Position;
};
type Node = TextNode | ValueNode | IfNode | EachNode;
type BlockNode = IfNode | EachNode;

type Frame = {
  node: BlockNode;
  parent: Node[];
  sawElse: boolean;
};

type Context = {
  root: unknown;
  current: unknown;
  index: number | undefined;
  inEach: boolean;
};

function positionAt(source: string, index: number): Position {
  let line = 1;
  let column = 1;
  for (let i = 0; i < index; i++) {
    if (source.charCodeAt(i) === 10) {
      line++;
      column = 1;
    } else {
      column++;
    }
  }
  return { index, line, column };
}

function syntaxError(message: string, position: Position): Error {
  return new Error(`${message} at line ${position.line}, column ${position.column}`);
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
    const endMarker = triple ? "}}}" : "}}";
    const contentStart = start + (triple ? 3 : 2);
    const end = source.indexOf(endMarker, contentStart);
    const position = positionAt(source, start);
    if (end === -1) throw syntaxError("Unclosed tag", position);

    const content = source.slice(contentStart, end).trim();
    cursor = end + endMarker.length;

    if (triple) {
      if (!content) throw syntaxError("Interpolation path cannot be empty", position);
      output.push({ type: "value", path: content, escaped: false, position });
      continue;
    }

    if (content.startsWith("!")) continue;

    if (content.startsWith("#")) {
      const match = /^#(if|each)(?:\s+(.+))$/.exec(content);
      if (!match) {
        const name = /^#([^\s]*)/.exec(content)?.[1] || "(empty)";
        if (name === "if" || name === "each") {
          throw syntaxError(`${name} block requires a path`, position);
        }
        throw syntaxError(`Unknown block \"${name}\"`, position);
      }
      const kind = match[1] as "if" | "each";
      const path = match[2]!.trim();
      if (!path) throw syntaxError(`${kind} block requires a path`, position);
      const node: BlockNode = kind === "if"
        ? { type: "if", path, truthy: [], falsy: [], position }
        : { type: "each", path, items: [], empty: [], position };
      output.push(node);
      stack.push({ node, parent: output, sawElse: false });
      output = node.type === "if" ? node.truthy : node.items;
      continue;
    }

    if (content === "else") {
      const frame = stack.at(-1);
      if (!frame) throw syntaxError("else outside a block", position);
      if (frame.sawElse) throw syntaxError("Duplicate else", position);
      frame.sawElse = true;
      output = frame.node.type === "if" ? frame.node.falsy : frame.node.empty;
      continue;
    }
    if (/^else\b/.test(content)) throw syntaxError("Malformed else tag", position);

    if (content.startsWith("/")) {
      const close = content.slice(1).trim();
      if (close !== "if" && close !== "each") {
        throw syntaxError(`Unknown closing block \"${close || "(empty)"}\"`, position);
      }
      const frame = stack.at(-1);
      if (!frame) throw syntaxError(`Closing ${close} without an open block`, position);
      if (frame.node.type !== close) {
        throw syntaxError(`Mismatched closing block: expected /${frame.node.type}, got /${close}`, position);
      }
      stack.pop();
      output = frame.parent;
      continue;
    }

    if (!content) throw syntaxError("Interpolation path cannot be empty", position);
    output.push({ type: "value", path: content, escaped: true, position });
  }

  const unclosed = stack.at(-1);
  if (unclosed) throw syntaxError(`Unclosed ${unclosed.node.type} block`, unclosed.node.position);
  return root;
}

function isLookupObject(value: unknown): value is Record<PropertyKey, unknown> {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

function lookup(base: unknown, parts: string[]): { found: boolean; value: unknown } {
  let value = base;
  for (const part of parts) {
    if (!isLookupObject(value) || !Object.prototype.hasOwnProperty.call(value, part)) {
      return { found: false, value: undefined };
    }
    value = value[part];
  }
  return { found: true, value };
}

function resolve(path: string, context: Context): unknown {
  if (path === "this") return context.inEach ? context.current : context.root;
  if (path.startsWith("this.")) {
    const base = context.inEach ? context.current : context.root;
    return lookup(base, path.slice(5).split(".")).value;
  }
  if (path === "@index") return context.inEach ? context.index : undefined;

  const parts = path.split(".");
  if (context.inEach) {
    const local = lookup(context.current, parts);
    if (local.found) return local.value;
  }
  return lookup(context.root, parts).value;
}

function isTruthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return value !== "" && value !== 0 && value !== 0n && value !== false && value !== null && value !== undefined;
}

function scalarText(value: unknown, path: string, position: Position): string {
  if (value === null || value === undefined) return "";
  switch (typeof value) {
    case "string":
    case "number":
    case "boolean":
    case "bigint":
      return String(value);
    default:
      throw syntaxError(`Value at \"${path}\" cannot be rendered as scalar text`, position);
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case "\"": return "&quot;";
      default: return "&#39;";
    }
  });
}

function renderNodes(nodes: Node[], context: Context): string {
  let result = "";
  for (const node of nodes) {
    if (node.type === "text") {
      result += node.value;
    } else if (node.type === "value") {
      const text = scalarText(resolve(node.path, context), node.path, node.position);
      result += node.escaped ? escapeHtml(text) : text;
    } else if (node.type === "if") {
      const branch = isTruthy(resolve(node.path, context)) ? node.truthy : node.falsy;
      result += renderNodes(branch, context);
    } else {
      const value = resolve(node.path, context);
      if (!Array.isArray(value) || value.length === 0) {
        result += renderNodes(node.empty, context);
        continue;
      }
      for (let index = 0; index < value.length; index++) {
        result += renderNodes(node.items, {
          root: context.root,
          current: value[index],
          index,
          inEach: true,
        });
      }
    }
  }
  return result;
}

/** Render a Mini Template string using the supplied data. */
export function render(template: string, data: unknown): string {
  const nodes = parse(template);
  return renderNodes(nodes, { root: data, current: data, index: undefined, inEach: false });
}
