type Position = {
  line: number;
  column: number;
};

type TextNode = { type: "text"; value: string };
type InterpolationNode = {
  type: "interpolation";
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
type Node = TextNode | InterpolationNode | BlockNode;

type Frame = {
  block: BlockNode;
  parent: Node[];
  inElse: boolean;
};

type Context = {
  root: unknown;
  current: unknown;
  index: number | undefined;
};

const PATH = /^(?:this|@index|[A-Za-z_$][\w$]*)(?:\.[A-Za-z_$][\w$]*)*$/;

function error(message: string, position: Position): Error {
  return new Error(`${message} at line ${position.line}, column ${position.column}`);
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

function validatePath(path: string, position: Position): void {
  if (!PATH.test(path)) {
    throw error(path ? `Invalid path \"${path}\"` : "Expected a path", position);
  }
}

function parse(template: string): Node[] {
  const root: Node[] = [];
  const stack: Frame[] = [];
  let target = root;
  let cursor = 0;

  while (cursor < template.length) {
    const open = template.indexOf("{{", cursor);
    if (open === -1) {
      target.push({ type: "text", value: template.slice(cursor) });
      break;
    }
    if (open > cursor) {
      target.push({ type: "text", value: template.slice(cursor, open) });
    }

    const position = positionAt(template, open);
    const triple = template.startsWith("{{{", open);
    const closeToken = triple ? "}}}" : "}}";
    const contentStart = open + (triple ? 3 : 2);
    const close = template.indexOf(closeToken, contentStart);
    if (close === -1) {
      throw error("Unclosed tag", position);
    }

    const content = template.slice(contentStart, close).trim();
    cursor = close + closeToken.length;

    if (triple) {
      validatePath(content, position);
      target.push({ type: "interpolation", path: content, escaped: false, position });
      continue;
    }

    if (content.startsWith("!")) continue;

    if (content.startsWith("#")) {
      const match = /^#(if|each)(?:\s+(.+))?$/.exec(content);
      if (!match) {
        const name = content.slice(1).split(/\s/, 1)[0] || "";
        throw error(`Unknown block \"${name}\"`, position);
      }
      const path = (match[2] ?? "").trim();
      validatePath(path, position);
      const block: BlockNode = {
        type: match[1] as "if" | "each",
        path,
        truthy: [],
        falsy: [],
        position,
      };
      target.push(block);
      stack.push({ block, parent: target, inElse: false });
      target = block.truthy;
      continue;
    }

    if (content === "else") {
      const frame = stack.at(-1);
      if (!frame) throw error("else outside a block", position);
      if (frame.inElse) throw error("Duplicate else", position);
      frame.inElse = true;
      target = frame.block.falsy;
      continue;
    }

    if (content.startsWith("/")) {
      const name = content.slice(1).trim();
      const frame = stack.at(-1);
      if (!frame) throw error(`Unexpected closing block \"${name}\"`, position);
      if (name !== frame.block.type) {
        throw error(
          `Mismatched closing block: expected /${frame.block.type}, got /${name}`,
          position,
        );
      }
      stack.pop();
      target = frame.parent;
      continue;
    }

    validatePath(content, position);
    target.push({ type: "interpolation", path: content, escaped: true, position });
  }

  const unclosed = stack.at(-1);
  if (unclosed) {
    throw error(`Unclosed ${unclosed.block.type} block`, unclosed.block.position);
  }
  return root;
}

function property(value: unknown, key: string): unknown {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") {
    return undefined;
  }
  return Object.prototype.hasOwnProperty.call(value, key)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function traverse(value: unknown, parts: string[]): unknown {
  for (const part of parts) {
    value = property(value, part);
    if (value === undefined) break;
  }
  return value;
}

function resolve(path: string, context: Context): unknown {
  const parts = path.split(".");
  if (parts[0] === "this") return traverse(context.current, parts.slice(1));
  if (parts[0] === "@index") {
    return parts.length === 1 ? context.index : traverse(context.index, parts.slice(1));
  }

  const local = traverse(context.current, parts);
  if (local !== undefined) return local;
  return context.current === context.root ? local : traverse(context.root, parts);
}

function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return value !== "" && value !== 0 && value !== false && value != null;
}

function scalar(value: unknown, node: InterpolationNode): string {
  if (value == null) return "";
  switch (typeof value) {
    case "string":
    case "number":
    case "boolean":
    case "bigint":
      return String(value);
    default:
      throw error(`Cannot render non-scalar value at \"${node.path}\"`, node.position);
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
    } else if (node.type === "interpolation") {
      const value = scalar(resolve(node.path, context), node);
      output += node.escaped ? escapeHtml(value) : value;
    } else if (node.type === "if") {
      const branch = truthy(resolve(node.path, context)) ? node.truthy : node.falsy;
      output += renderNodes(branch, context);
    } else {
      const value = resolve(node.path, context);
      if (Array.isArray(value) && value.length > 0) {
        for (let index = 0; index < value.length; index++) {
          output += renderNodes(node.truthy, {
            root: context.root,
            current: value[index],
            index,
          });
        }
      } else {
        output += renderNodes(node.falsy, context);
      }
    }
  }
  return output;
}

/** Render a Mini Template string with the supplied data. */
export function render(template: string, data: unknown): string {
  return renderNodes(parse(template), { root: data, current: data, index: undefined });
}
