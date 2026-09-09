type Position = { line: number; column: number };

type Node =
  | { type: "text"; value: string }
  | { type: "value"; path: string; escaped: boolean; position: Position }
  | {
      type: "if";
      path: string;
      truthy: Node[];
      falsy: Node[];
      position: Position;
    }
  | {
      type: "each";
      path: string;
      body: Node[];
      empty: Node[];
      position: Position;
    };

type BlockNode = Extract<Node, { type: "if" | "each" }>;

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

const MISSING = Symbol("missing");

class TemplateError extends Error {
  constructor(message: string, position: Position) {
    super(`${message} at line ${position.line}, column ${position.column}`);
    this.name = "TemplateError";
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
  return { line, column };
}

function requirePath(path: string, kind: string, position: Position): string {
  if (!path) throw new TemplateError(`${kind} requires a path`, position);
  return path;
}

function parse(template: string): Node[] {
  const root: Node[] = [];
  const stack: Frame[] = [];
  let output = root;
  let cursor = 0;

  while (cursor < template.length) {
    const opening = template.indexOf("{{", cursor);
    if (opening === -1) {
      output.push({ type: "text", value: template.slice(cursor) });
      break;
    }
    if (opening > cursor) {
      output.push({ type: "text", value: template.slice(cursor, opening) });
    }

    const triple = template.startsWith("{{{", opening);
    const closeToken = triple ? "}}}" : "}}";
    const contentStart = opening + (triple ? 3 : 2);
    const closing = template.indexOf(closeToken, contentStart);
    const position = positionAt(template, opening);
    if (closing === -1) {
      throw new TemplateError("Unclosed tag", position);
    }

    const tag = template.slice(contentStart, closing).trim();
    cursor = closing + closeToken.length;

    if (triple) {
      output.push({
        type: "value",
        path: requirePath(tag, "Interpolation", position),
        escaped: false,
        position,
      });
      continue;
    }

    if (tag.startsWith("!")) continue;

    if (tag === "else") {
      const frame = stack.at(-1);
      if (!frame) throw new TemplateError("else outside a block", position);
      if (frame.inElse) throw new TemplateError("Duplicate else", position);
      frame.inElse = true;
      output = frame.node.type === "if" ? frame.node.falsy : frame.node.empty;
      continue;
    }

    if (tag.startsWith("#")) {
      const match = /^#([^\s]+)(?:\s+(.*))?$/.exec(tag);
      const blockKind = match?.[1] ?? tag.slice(1);
      if (blockKind !== "if" && blockKind !== "each") {
        throw new TemplateError(`Unknown block ${JSON.stringify(blockKind)}`, position);
      }
      const path = requirePath(match?.[2]?.trim() ?? "", `${blockKind} block`, position);
      const node: BlockNode =
        blockKind === "if"
          ? { type: "if", path, truthy: [], falsy: [], position }
          : { type: "each", path, body: [], empty: [], position };
      output.push(node);
      stack.push({ node, parent: output, inElse: false });
      output = node.type === "if" ? node.truthy : node.body;
      continue;
    }

    if (tag.startsWith("/")) {
      const closeKind = tag.slice(1).trim();
      const frame = stack.at(-1);
      if (!frame) {
        throw new TemplateError(`Closing ${JSON.stringify(closeKind)} without an open block`, position);
      }
      if (closeKind !== frame.node.type) {
        throw new TemplateError(
          `Mismatched closing block: expected /${frame.node.type} but found /${closeKind}`,
          position,
        );
      }
      stack.pop();
      output = frame.parent;
      continue;
    }

    output.push({
      type: "value",
      path: requirePath(tag, "Interpolation", position),
      escaped: true,
      position,
    });
  }

  const unclosed = stack.at(-1)?.node;
  if (unclosed) {
    throw new TemplateError(`Unclosed ${unclosed.type} block`, unclosed.position);
  }
  return root;
}

function property(value: unknown, key: string): unknown | typeof MISSING {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") {
    return MISSING;
  }
  if (!Object.prototype.hasOwnProperty.call(value, key)) return MISSING;
  return (value as Record<string, unknown>)[key];
}

function walk(value: unknown, parts: string[]): unknown | typeof MISSING {
  let result: unknown | typeof MISSING = value;
  for (const part of parts) {
    if (result === MISSING) return MISSING;
    result = property(result, part);
  }
  return result;
}

function resolve(path: string, context: Context): unknown | typeof MISSING {
  if (path === "this") return context.inEach ? context.current : context.root;
  if (path.startsWith("this.")) {
    const base = context.inEach ? context.current : context.root;
    return walk(base, path.slice(5).split("."));
  }
  if (path === "@index") return context.inEach ? context.index : MISSING;

  const parts = path.split(".");
  if (context.inEach) {
    const local = walk(context.current, parts);
    if (local !== MISSING) return local;
  }
  return walk(context.root, parts);
}

function isTruthy(value: unknown | typeof MISSING): boolean {
  if (value === MISSING || value === null || value === undefined || value === false) return false;
  if (value === "" || value === 0) return false;
  if (Array.isArray(value) && value.length === 0) return false;
  return true;
}

function scalar(value: unknown | typeof MISSING, path: string, position: Position): string {
  if (value === MISSING || value === null || value === undefined) return "";
  switch (typeof value) {
    case "string":
    case "number":
    case "bigint":
    case "boolean":
      return String(value);
    default:
      throw new TemplateError(`Value at ${JSON.stringify(path)} is not scalar text`, position);
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
      continue;
    }
    const value = resolve(node.path, context);
    if (node.type === "value") {
      const text = scalar(value, node.path, node.position);
      result += node.escaped ? escapeHtml(text) : text;
    } else if (node.type === "if") {
      result += renderNodes(isTruthy(value) ? node.truthy : node.falsy, context);
    } else {
      if (Array.isArray(value) && value.length > 0) {
        for (let index = 0; index < value.length; index++) {
          result += renderNodes(node.body, {
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

export function render(template: string, data: unknown): string {
  return renderNodes(parse(template), {
    root: data,
    current: data,
    index: undefined,
    inEach: false,
  });
}
