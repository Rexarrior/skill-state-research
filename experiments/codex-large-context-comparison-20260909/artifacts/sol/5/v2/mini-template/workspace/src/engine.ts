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
  body: Node[];
  alternate: Node[];
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

const own = Object.prototype.hasOwnProperty;

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
  if (!path) throw syntaxError("Expected a path", position);
  if (path === "this" || path === "@index") return;
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/.test(path)) {
    throw syntaxError(`Invalid path "${path}"`, position);
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
    if (open > cursor) target.push({ type: "text", value: template.slice(cursor, open) });

    const triple = template.startsWith("{{{", open);
    const closeToken = triple ? "}}}" : "}}";
    const contentStart = open + (triple ? 3 : 2);
    const close = template.indexOf(closeToken, contentStart);
    const position = positionAt(template, open);
    if (close === -1) throw syntaxError("Unclosed tag", position);

    const content = template.slice(contentStart, close).trim();
    cursor = close + closeToken.length;

    if (triple) {
      validatePath(content, position);
      target.push({ type: "interpolation", path: content, escaped: false, position });
      continue;
    }

    if (content.startsWith("!")) continue;

    if (content.startsWith("#")) {
      const match = /^#(if|each)(?:\s+(.+?))?$/.exec(content);
      if (!match) {
        const name = content.slice(1).split(/\s/, 1)[0] || content;
        throw syntaxError(`Unknown block "${name}"`, position);
      }
      const path = match[2]?.trim() ?? "";
      validatePath(path, position);
      const block: BlockNode = {
        type: match[1] as "if" | "each",
        path,
        body: [],
        alternate: [],
        position,
      };
      target.push(block);
      stack.push({ block, parent: target, inElse: false });
      target = block.body;
      continue;
    }

    if (content === "else") {
      const frame = stack.at(-1);
      if (!frame) throw syntaxError("{{else}} outside a block", position);
      if (frame.inElse) throw syntaxError("Duplicate {{else}}", position);
      frame.inElse = true;
      target = frame.block.alternate;
      continue;
    }

    if (content.startsWith("/")) {
      const name = content.slice(1).trim();
      if (name !== "if" && name !== "each") {
        throw syntaxError(`Unknown closing block "${name}"`, position);
      }
      const frame = stack.at(-1);
      if (!frame) throw syntaxError(`Unexpected closing block "${name}"`, position);
      if (frame.block.type !== name) {
        throw syntaxError(
          `Mismatched closing block: expected "/${frame.block.type}" but found "/${name}"`,
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

  const unclosed = stack.at(-1)?.block;
  if (unclosed) throw syntaxError(`Unclosed block "${unclosed.type}"`, unclosed.position);
  return root;
}

function lookupIn(value: unknown, parts: string[]): { found: boolean; value: unknown } {
  let cursor = value;
  for (const part of parts) {
    if ((typeof cursor !== "object" && typeof cursor !== "function") || cursor === null) {
      return { found: false, value: undefined };
    }
    if (!own.call(cursor, part)) return { found: false, value: undefined };
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return { found: true, value: cursor };
}

function resolve(path: string, context: Context): unknown {
  if (path === "this") return context.current;
  if (path === "@index") return context.index;
  const parts = path.split(".");
  const local = lookupIn(context.current, parts);
  if (local.found) return local.value;
  return lookupIn(context.root, parts).value;
}

function isTruthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return value !== "" && value !== 0 && value !== false && value != null;
}

function scalar(value: unknown, path: string, position: Position): string {
  if (value == null) return "";
  switch (typeof value) {
    case "string":
    case "number":
    case "bigint":
    case "boolean":
      return String(value);
    default:
      throw syntaxError(`Value at "${path}" is not a renderable scalar`, position);
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
      const text = scalar(resolve(node.path, context), node.path, node.position);
      output += node.escaped ? escapeHtml(text) : text;
    } else if (node.type === "if") {
      output += renderNodes(
        isTruthy(resolve(node.path, context)) ? node.body : node.alternate,
        context,
      );
    } else {
      const value = resolve(node.path, context);
      if (Array.isArray(value) && value.length > 0) {
        for (let index = 0; index < value.length; index++) {
          output += renderNodes(node.body, { root: context.root, current: value[index], index });
        }
      } else {
        output += renderNodes(node.alternate, context);
      }
    }
  }
  return output;
}

/** Render a Mini Template string with the supplied data. */
export function render(template: string, data: unknown): string {
  return renderNodes(parse(template), { root: data, current: data, index: undefined });
}
