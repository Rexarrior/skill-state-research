type Position = {
  line: number;
  column: number;
};

type TextNode = { type: "text"; value: string };
type ValueNode = { type: "value"; path: string; escaped: boolean; position: Position };
type BlockNode = {
  type: "if" | "each";
  path: string;
  then: Node[];
  otherwise: Node[];
  position: Position;
};
type Node = TextNode | ValueNode | BlockNode;

type OpenBlock = {
  node: BlockNode;
  parent: Node[];
  inElse: boolean;
};

type Context = {
  root: unknown;
  item?: unknown;
  index?: number;
  inEach: boolean;
};

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

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

function syntaxError(message: string, position: Position): Error {
  return new Error(`${message} at line ${position.line}, column ${position.column}`);
}

function validatePath(path: string, position: Position): void {
  if (path === "this" || path === "@index") return;
  if (!path || !path.split(".").every((part) => IDENTIFIER.test(part))) {
    throw syntaxError(`Invalid path ${JSON.stringify(path)}`, position);
  }
}

function parse(template: string): Node[] {
  const root: Node[] = [];
  const stack: OpenBlock[] = [];
  let current = root;
  let cursor = 0;

  while (cursor < template.length) {
    const start = template.indexOf("{{", cursor);
    if (start === -1) {
      current.push({ type: "text", value: template.slice(cursor) });
      break;
    }
    if (start > cursor) current.push({ type: "text", value: template.slice(cursor, start) });

    const triple = template.startsWith("{{{", start);
    const close = triple ? "}}}" : "}}";
    const contentStart = start + (triple ? 3 : 2);
    const end = template.indexOf(close, contentStart);
    const position = positionAt(template, start);
    if (end === -1) throw syntaxError("Unclosed tag", position);

    const raw = template.slice(contentStart, end).trim();
    cursor = end + close.length;
    if (!raw) throw syntaxError("Empty tag", position);

    if (triple) {
      validatePath(raw, position);
      current.push({ type: "value", path: raw, escaped: false, position });
      continue;
    }

    if (raw.startsWith("!")) continue;

    if (raw.startsWith("#")) {
      const match = /^#(if|each)\s+(.+)$/.exec(raw);
      if (!match) {
        const name = raw.slice(1).split(/\s/, 1)[0] || raw;
        throw syntaxError(`Unknown or malformed block ${JSON.stringify(name)}`, position);
      }
      const type = match[1] as "if" | "each";
      const path = match[2].trim();
      validatePath(path, position);
      const node: BlockNode = { type, path, then: [], otherwise: [], position };
      current.push(node);
      stack.push({ node, parent: current, inElse: false });
      current = node.then;
      continue;
    }

    if (raw === "else") {
      const open = stack[stack.length - 1];
      if (!open) throw syntaxError("else outside a block", position);
      if (open.inElse) throw syntaxError("Duplicate else", position);
      open.inElse = true;
      current = open.node.otherwise;
      continue;
    }

    if (raw.startsWith("/")) {
      const name = raw.slice(1).trim();
      if (name !== "if" && name !== "each") {
        throw syntaxError(`Unknown closing block ${JSON.stringify(name)}`, position);
      }
      const open = stack[stack.length - 1];
      if (!open) throw syntaxError(`Closing ${name} without an open block`, position);
      if (open.node.type !== name) {
        throw syntaxError(`Mismatched closing block: expected /${open.node.type}, got /${name}`, position);
      }
      stack.pop();
      current = open.parent;
      continue;
    }

    validatePath(raw, position);
    current.push({ type: "value", path: raw, escaped: true, position });
  }

  const unclosed = stack[stack.length - 1];
  if (unclosed) {
    throw syntaxError(`Unclosed ${unclosed.node.type} block`, unclosed.node.position);
  }
  return root;
}

function property(value: unknown, key: string): unknown {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") return undefined;
  if (!Object.prototype.hasOwnProperty.call(value, key)) return undefined;
  return (value as Record<string, unknown>)[key];
}

function walk(value: unknown, parts: string[]): unknown {
  for (const part of parts) value = property(value, part);
  return value;
}

function resolve(path: string, context: Context): unknown {
  if (path === "this") return context.inEach ? context.item : property(context.root, "this");
  if (path === "@index") return context.inEach ? context.index : undefined;
  return walk(context.root, path.split("."));
}

function isTruthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return value !== "" && value !== 0 && value !== false && value !== null && value !== undefined;
}

function scalar(value: unknown, path: string, position: Position): string {
  if (value === null || value === undefined) return "";
  switch (typeof value) {
    case "string":
    case "number":
    case "bigint":
    case "boolean":
      return String(value);
    default:
      throw syntaxError(`Value at ${JSON.stringify(path)} cannot be rendered as scalar text`, position);
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

function renderNodes(nodes: Node[], context: Context): string {
  let output = "";
  for (const node of nodes) {
    if (node.type === "text") {
      output += node.value;
    } else if (node.type === "value") {
      const value = scalar(resolve(node.path, context), node.path, node.position);
      output += node.escaped ? escapeHtml(value) : value;
    } else if (node.type === "if") {
      output += renderNodes(isTruthy(resolve(node.path, context)) ? node.then : node.otherwise, context);
    } else {
      const value = resolve(node.path, context);
      if (Array.isArray(value) && value.length > 0) {
        for (let index = 0; index < value.length; index++) {
          output += renderNodes(node.then, {
            root: context.root,
            item: value[index],
            index,
            inEach: true,
          });
        }
      } else {
        output += renderNodes(node.otherwise, context);
      }
    }
  }
  return output;
}

/** Render a Mini Template string with the supplied root data. */
export function render(template: string, data: unknown): string {
  return renderNodes(parse(template), { root: data, inEach: false });
}
