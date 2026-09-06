type Position = {
  index: number;
  line: number;
  column: number;
};

type TextNode = { type: "text"; value: string };
type ValueNode = {
  type: "value";
  path: string;
  escaped: boolean;
  position: Position;
};
type BlockNode = {
  type: "if" | "each";
  path: string;
  truthy: Node[];
  falsy: Node[];
  position: Position;
};
type Node = TextNode | ValueNode | BlockNode;

type Frame = {
  node: BlockNode;
  parent: Node[];
  inElse: boolean;
};

type Context = {
  root: unknown;
  current: unknown;
  index: number | undefined;
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

function positionAt(source: string, index: number): Position {
  let line = 1;
  let column = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (source[cursor] === "\n") {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { index, line, column };
}

function validPath(path: string): boolean {
  if (path === "this" || path === "@index") return true;
  const parts = path.startsWith("this.") ? path.slice(5).split(".") : path.split(".");
  return parts.length > 0 && parts.every((part) => part.length > 0 && !/\s|[{}]/u.test(part));
}

function requirePath(path: string, kind: string, position: Position): string {
  if (!validPath(path)) {
    throw new TemplateError(`Invalid ${kind} path${path ? ` "${path}"` : ""}`, position);
  }
  return path;
}

function parse(template: string): Node[] {
  const root: Node[] = [];
  const stack: Frame[] = [];
  let output = root;
  let cursor = 0;

  while (cursor < template.length) {
    const open = template.indexOf("{{", cursor);
    if (open === -1) {
      output.push({ type: "text", value: template.slice(cursor) });
      break;
    }
    if (open > cursor) output.push({ type: "text", value: template.slice(cursor, open) });

    const triple = template.startsWith("{{{", open);
    const closeText = triple ? "}}}" : "}}";
    const contentStart = open + (triple ? 3 : 2);
    const close = template.indexOf(closeText, contentStart);
    const position = positionAt(template, open);
    if (close === -1) throw new TemplateError("Unclosed tag", position);

    const content = template.slice(contentStart, close).trim();
    cursor = close + closeText.length;

    if (triple) {
      output.push({ type: "value", path: requirePath(content, "interpolation", position), escaped: false, position });
      continue;
    }
    if (content.startsWith("!")) continue;

    if (content.startsWith("#")) {
      const match = /^#(if|each)(?:\s+)(.*?)$/u.exec(content);
      if (!match) {
        const name = content.slice(1).split(/\s/u, 1)[0] || "(empty)";
        throw new TemplateError(`Unknown or malformed block "${name}"`, position);
      }
      const node: BlockNode = {
        type: match[1] as "if" | "each",
        path: requirePath(match[2].trim(), `${match[1]} block`, position),
        truthy: [],
        falsy: [],
        position,
      };
      output.push(node);
      stack.push({ node, parent: output, inElse: false });
      output = node.truthy;
      continue;
    }

    if (content === "else") {
      const frame = stack.at(-1);
      if (!frame) throw new TemplateError("Unexpected else outside a block", position);
      if (frame.inElse) throw new TemplateError("Duplicate else", position);
      frame.inElse = true;
      output = frame.node.falsy;
      continue;
    }

    if (content.startsWith("/")) {
      const name = content.slice(1).trim();
      if (name !== "if" && name !== "each") {
        throw new TemplateError(`Unknown closing block "${name || "(empty)"}"`, position);
      }
      const frame = stack.at(-1);
      if (!frame) throw new TemplateError(`Unexpected closing block "${name}"`, position);
      if (frame.node.type !== name) {
        throw new TemplateError(`Mismatched closing block: expected "/${frame.node.type}", got "/${name}"`, position);
      }
      stack.pop();
      output = frame.parent;
      continue;
    }

    output.push({ type: "value", path: requirePath(content, "interpolation", position), escaped: true, position });
  }

  const unclosed = stack.at(-1);
  if (unclosed) {
    throw new TemplateError(`Unclosed "${unclosed.node.type}" block`, unclosed.node.position);
  }
  return root;
}

function property(value: unknown, keys: string[]): unknown {
  let result = value;
  for (const key of keys) {
    if ((typeof result !== "object" || result === null) && typeof result !== "function") return undefined;
    result = (result as Record<string, unknown>)[key];
  }
  return result;
}

function resolve(path: string, context: Context): unknown {
  if (path === "this") return context.current;
  if (path === "@index") return context.index;
  if (path.startsWith("this.")) return property(context.current, path.slice(5).split("."));
  return property(context.root, path.split("."));
}

function truthy(value: unknown): boolean {
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
      throw new TemplateError(`Value at "${path}" is not scalar text`, position);
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => {
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
      const text = scalar(resolve(node.path, context), node.path, node.position);
      result += node.escaped ? escapeHtml(text) : text;
    } else if (node.type === "if") {
      const branch = truthy(resolve(node.path, context)) ? node.truthy : node.falsy;
      result += renderNodes(branch, context);
    } else {
      const items = resolve(node.path, context);
      if (Array.isArray(items) && items.length > 0) {
        for (let index = 0; index < items.length; index += 1) {
          result += renderNodes(node.truthy, { root: context.root, current: items[index], index });
        }
      } else {
        result += renderNodes(node.falsy, context);
      }
    }
  }
  return result;
}

/** Render a Mini Template string with values from data. */
export function render(template: string, data: unknown): string {
  return renderNodes(parse(template), { root: data, current: data, index: undefined });
}
