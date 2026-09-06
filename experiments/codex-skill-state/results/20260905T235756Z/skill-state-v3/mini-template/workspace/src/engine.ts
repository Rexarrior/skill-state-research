type Position = {
  offset: number;
  line: number;
  column: number;
};

type TextNode = { type: "text"; value: string };
type ValueNode = { type: "value"; path: string; escaped: boolean; position: Position };
type BlockNode = {
  type: "if" | "each";
  path: string;
  body: Node[];
  alternate: Node[];
  hasElse: boolean;
  position: Position;
};
type Node = TextNode | ValueNode | BlockNode;

type Frame = {
  block: BlockNode;
  parent: Node[];
};

type Context = {
  root: unknown;
  value: unknown;
  index?: number;
  inEach: boolean;
};

const MISSING = Symbol("missing");

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

function syntaxError(source: string, offset: number, message: string): Error {
  const { line, column } = positionAt(source, offset);
  return new Error(`${message} at line ${line}, column ${column}`);
}

function parse(source: string): Node[] {
  const root: Node[] = [];
  const stack: Frame[] = [];
  let current = root;
  let cursor = 0;

  while (cursor < source.length) {
    const open = source.indexOf("{{", cursor);
    if (open === -1) {
      current.push({ type: "text", value: source.slice(cursor) });
      break;
    }

    if (open > cursor) {
      current.push({ type: "text", value: source.slice(cursor, open) });
    }

    const triple = source.startsWith("{{{", open);
    const closing = triple ? "}}}" : "}}";
    const contentStart = open + (triple ? 3 : 2);
    const close = source.indexOf(closing, contentStart);
    if (close === -1) {
      throw syntaxError(source, open, "Unclosed template tag");
    }

    const tag = source.slice(contentStart, close).trim();
    const position = positionAt(source, open);
    cursor = close + closing.length;

    if (triple) {
      current.push({ type: "value", path: tag, escaped: false, position });
      continue;
    }

    if (tag.startsWith("!")) {
      continue;
    }

    if (tag === "else") {
      const frame = stack.at(-1);
      if (!frame) {
        throw syntaxError(source, open, "Unexpected else outside a block");
      }
      if (frame.block.hasElse) {
        throw syntaxError(source, open, "Duplicate else");
      }
      frame.block.hasElse = true;
      current = frame.block.alternate;
      continue;
    }

    if (tag.startsWith("#")) {
      const match = /^#(if|each)(?:\s+(.+))?$/.exec(tag);
      if (!match) {
        const name = tag.slice(1).trim().split(/\s+/, 1)[0] || tag;
        throw syntaxError(source, open, `Unknown block '${name}'`);
      }
      const path = match[2]?.trim();
      if (!path) {
        throw syntaxError(source, open, `Missing path for ${match[1]} block`);
      }

      const block: BlockNode = {
        type: match[1] as "if" | "each",
        path,
        body: [],
        alternate: [],
        hasElse: false,
        position,
      };
      current.push(block);
      stack.push({ block, parent: current });
      current = block.body;
      continue;
    }

    if (tag.startsWith("/")) {
      const name = tag.slice(1).trim();
      if (name !== "if" && name !== "each") {
        throw syntaxError(source, open, `Unknown closing block '${name}'`);
      }
      const frame = stack.at(-1);
      if (!frame) {
        throw syntaxError(source, open, `Unexpected closing block '${name}'`);
      }
      if (frame.block.type !== name) {
        throw syntaxError(
          source,
          open,
          `Mismatched closing block '${name}'; expected '${frame.block.type}'`,
        );
      }
      stack.pop();
      current = frame.parent;
      continue;
    }

    current.push({ type: "value", path: tag, escaped: true, position });
  }

  const unclosed = stack.at(-1)?.block;
  if (unclosed) {
    throw syntaxError(
      source,
      unclosed.position.offset,
      `Unclosed '${unclosed.type}' block`,
    );
  }

  return root;
}

function property(value: unknown, segments: string[]): unknown | typeof MISSING {
  let current = value;

  for (const segment of segments) {
    if (!segment || (typeof current !== "object" && typeof current !== "function") || current === null) {
      return MISSING;
    }
    if (!Object.prototype.hasOwnProperty.call(current, segment)) {
      return MISSING;
    }
    current = (current as Record<string, unknown>)[segment];
  }

  return current;
}

function resolve(path: string, context: Context): unknown | typeof MISSING {
  if (!path) return MISSING;
  if (path === "this") return context.value;
  if (path === "@index") return context.index ?? MISSING;

  if (path.startsWith("this.")) {
    return property(context.value, path.slice(5).split("."));
  }

  const segments = path.split(".");
  if (context.inEach) {
    const local = property(context.value, segments);
    if (local !== MISSING) return local;
  }
  return property(context.root, segments);
}

function isTruthy(value: unknown | typeof MISSING): boolean {
  if (value === MISSING || value === undefined || value === null || value === false) return false;
  if (typeof value === "string" && value.length === 0) return false;
  if (typeof value === "number" && value === 0) return false;
  if (Array.isArray(value) && value.length === 0) return false;
  return true;
}

function scalar(value: unknown | typeof MISSING, node: ValueNode): string {
  if (value === MISSING || value === undefined || value === null) return "";
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }
  throw new Error(
    `Cannot render non-scalar value for '${node.path}' at line ${node.position.line}, column ${node.position.column}`,
  );
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
      continue;
    }

    if (node.type === "value") {
      const text = scalar(resolve(node.path, context), node);
      output += node.escaped ? escapeHtml(text) : text;
      continue;
    }

    const value = resolve(node.path, context);
    if (node.type === "if") {
      output += renderNodes(isTruthy(value) ? node.body : node.alternate, context);
      continue;
    }

    if (Array.isArray(value) && value.length > 0) {
      for (let index = 0; index < value.length; index++) {
        output += renderNodes(node.body, {
          root: context.root,
          value: value[index],
          index,
          inEach: true,
        });
      }
    } else {
      output += renderNodes(node.alternate, context);
    }
  }

  return output;
}

/** Render a Mini Template string with the supplied data. */
export function render(template: string, data: unknown): string {
  return renderNodes(parse(template), {
    root: data,
    value: data,
    inEach: false,
  });
}
