type Position = {
  offset: number;
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
  inElse: boolean;
};

type Context = {
  root: unknown;
  current: unknown;
  index: number | undefined;
  inEach: boolean;
};

export class TemplateError extends Error {
  readonly line: number;
  readonly column: number;

  constructor(message: string, position: Position) {
    super(`${message} at line ${position.line}, column ${position.column}`);
    this.name = "TemplateError";
    this.line = position.line;
    this.column = position.column;
  }
}

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
  return { offset, line, column };
}

function requirePath(path: string, description: string, position: Position): string {
  const value = path.trim();
  if (!value) throw new TemplateError(`${description} requires a path`, position);
  if (value.split(".").some((part) => part.length === 0)) {
    throw new TemplateError(`Invalid path "${value}"`, position);
  }
  return value;
}

function parse(template: string): Node[] {
  const root: Node[] = [];
  const stack: Frame[] = [];
  let output = root;
  let cursor = 0;

  while (cursor < template.length) {
    const start = template.indexOf("{{", cursor);
    if (start === -1) {
      output.push({ type: "text", value: template.slice(cursor) });
      break;
    }
    if (start > cursor) output.push({ type: "text", value: template.slice(cursor, start) });

    const position = positionAt(template, start);
    const triple = template.startsWith("{{{", start);
    const openingLength = triple ? 3 : 2;
    const closing = triple ? "}}}" : "}}";
    const end = template.indexOf(closing, start + openingLength);
    if (end === -1) throw new TemplateError("Unclosed tag", position);

    const raw = template.slice(start + openingLength, end).trim();
    cursor = end + closing.length;

    if (triple) {
      output.push({
        type: "value",
        path: requirePath(raw, "Interpolation", position),
        escaped: false,
        position,
      });
      continue;
    }

    if (raw.startsWith("!")) continue;

    if (raw.startsWith("#")) {
      const match = /^#([^\s]+)(?:\s+(.*))?$/.exec(raw);
      const name = match?.[1] ?? "";
      const path = match?.[2] ?? "";
      if (name !== "if" && name !== "each") {
        throw new TemplateError(`Unknown block "${name || raw.slice(1)}"`, position);
      }
      const checkedPath = requirePath(path, `#${name}`, position);
      const node: BlockNode = name === "if"
        ? { type: "if", path: checkedPath, truthy: [], falsy: [], position }
        : { type: "each", path: checkedPath, items: [], empty: [], position };
      output.push(node);
      stack.push({ node, parent: output, inElse: false });
      output = node.type === "if" ? node.truthy : node.items;
      continue;
    }

    if (raw === "else") {
      const frame = stack.at(-1);
      if (!frame) throw new TemplateError("{{else}} outside a block", position);
      if (frame.inElse) throw new TemplateError("Duplicate {{else}}", position);
      frame.inElse = true;
      output = frame.node.type === "if" ? frame.node.falsy : frame.node.empty;
      continue;
    }

    if (raw.startsWith("/")) {
      const closeName = raw.slice(1).trim();
      if (!closeName || closeName.includes(" ")) {
        throw new TemplateError(`Invalid closing tag "${raw}"`, position);
      }
      const frame = stack.at(-1);
      if (!frame) throw new TemplateError(`Unexpected closing block "${closeName}"`, position);
      if (frame.node.type !== closeName) {
        throw new TemplateError(
          `Mismatched closing block: expected "${frame.node.type}", got "${closeName}"`,
          position,
        );
      }
      stack.pop();
      output = frame.parent;
      continue;
    }

    output.push({
      type: "value",
      path: requirePath(raw, "Interpolation", position),
      escaped: true,
      position,
    });
  }

  const unclosed = stack.at(-1);
  if (unclosed) {
    throw new TemplateError(`Unclosed #${unclosed.node.type} block`, unclosed.node.position);
  }
  return root;
}

function property(value: unknown, key: string): { found: boolean; value: unknown } {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    return { found: false, value: undefined };
  }
  if (!Object.prototype.hasOwnProperty.call(value, key)) return { found: false, value: undefined };
  return { found: true, value: (value as Record<string, unknown>)[key] };
}

function walk(value: unknown, parts: string[]): { found: boolean; value: unknown } {
  let result = value;
  for (const part of parts) {
    const next = property(result, part);
    if (!next.found) return next;
    result = next.value;
  }
  return { found: true, value: result };
}

function lookup(path: string, context: Context): unknown {
  if (path === "this") return context.inEach ? context.current : context.root;
  if (path === "@index") return context.inEach ? context.index : undefined;

  if (path.startsWith("this.")) {
    if (!context.inEach) return undefined;
    return walk(context.current, path.slice(5).split(".")).value;
  }

  const parts = path.split(".");
  if (context.inEach) {
    const local = walk(context.current, parts);
    if (local.found) return local.value;
  }
  return walk(context.root, parts).value;
}

function isTruthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return value !== "" && value !== 0 && value !== false && value !== null && value !== undefined;
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
      throw new TemplateError(`Value at "${path}" is not scalar and cannot be rendered`, position);
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
  let result = "";
  for (const node of nodes) {
    if (node.type === "text") {
      result += node.value;
    } else if (node.type === "value") {
      const value = scalar(lookup(node.path, context), node.path, node.position);
      result += node.escaped ? escapeHtml(value) : value;
    } else if (node.type === "if") {
      result += renderNodes(isTruthy(lookup(node.path, context)) ? node.truthy : node.falsy, context);
    } else {
      const value = lookup(node.path, context);
      if (Array.isArray(value) && value.length > 0) {
        for (let index = 0; index < value.length; index++) {
          result += renderNodes(node.items, {
            root: context.root,
            current: value[index],
            index,
            inEach: true,
          });
        }
      } else {
        result += renderNodes(node.empty, context);
      }
    }
  }
  return result;
}

/** Render a Mini Template string using the supplied data. */
export function render(template: string, data: unknown): string {
  return renderNodes(parse(template), {
    root: data,
    current: data,
    index: undefined,
    inEach: false,
  });
}
