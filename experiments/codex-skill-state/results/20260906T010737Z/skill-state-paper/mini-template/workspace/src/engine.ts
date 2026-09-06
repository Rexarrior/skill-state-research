type Position = {
  line: number;
  column: number;
};

type TextNode = {
  type: "text";
  value: string;
};

type ValueNode = {
  type: "value";
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

type Node = TextNode | ValueNode | BlockNode;

type StackEntry = {
  block: BlockNode;
  parent: Node[];
  inElse: boolean;
};

type Context = {
  root: unknown;
  current: unknown;
  index: number | undefined;
};

function positionAt(source: string, offset: number): Position {
  let line = 1;
  let column = 1;

  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }

  return { line, column };
}

function syntaxError(message: string, position: Position): Error {
  return new Error(`${message} at line ${position.line}, column ${position.column}`);
}

function parse(template: string): Node[] {
  const root: Node[] = [];
  const stack: StackEntry[] = [];
  let output = root;
  let cursor = 0;

  while (cursor < template.length) {
    const open = template.indexOf("{{", cursor);
    if (open === -1) {
      output.push({ type: "text", value: template.slice(cursor) });
      break;
    }

    if (open > cursor) {
      output.push({ type: "text", value: template.slice(cursor, open) });
    }

    const triple = template.startsWith("{{{", open);
    const closing = triple ? "}}}" : "}}";
    const contentStart = open + (triple ? 3 : 2);
    const close = template.indexOf(closing, contentStart);

    if (close === -1) {
      throw syntaxError("Unclosed template tag", positionAt(template, open));
    }

    const position = positionAt(template, open);
    const tag = template.slice(contentStart, close).trim();
    cursor = close + closing.length;

    if (triple) {
      output.push({ type: "value", path: tag, escaped: false, position });
      continue;
    }

    if (tag.startsWith("!")) {
      continue;
    }

    if (tag === "else") {
      const entry = stack.at(-1);
      if (!entry) {
        throw syntaxError("Unexpected else outside a block", position);
      }
      if (entry.inElse) {
        throw syntaxError("Duplicate else", position);
      }
      entry.inElse = true;
      output = entry.block.alternate;
      continue;
    }

    if (tag.startsWith("#")) {
      const match = /^#(if|each)(?:\s+(.+))$/.exec(tag);
      if (!match) {
        const name = tag.slice(1).split(/\s/, 1)[0] || tag;
        throw syntaxError(`Unknown or malformed block '${name}'`, position);
      }

      const block: BlockNode = {
        type: match[1] as "if" | "each",
        path: match[2].trim(),
        body: [],
        alternate: [],
        position,
      };
      output.push(block);
      stack.push({ block, parent: output, inElse: false });
      output = block.body;
      continue;
    }

    if (tag.startsWith("/")) {
      const name = tag.slice(1).trim();
      const entry = stack.at(-1);
      if (!entry) {
        throw syntaxError(`Unexpected closing block '${name}'`, position);
      }
      if (name !== entry.block.type) {
        throw syntaxError(
          `Mismatched closing block '${name}'; expected '${entry.block.type}'`,
          position,
        );
      }
      stack.pop();
      output = entry.parent;
      continue;
    }

    output.push({ type: "value", path: tag, escaped: true, position });
  }

  const unclosed = stack.at(-1);
  if (unclosed) {
    throw syntaxError(`Unclosed '${unclosed.block.type}' block`, unclosed.block.position);
  }

  return root;
}

function own(object: object, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(object, key)
    ? (object as Record<string, unknown>)[key]
    : undefined;
}

function walk(value: unknown, parts: string[]): unknown {
  let result = value;
  for (const part of parts) {
    if ((typeof result !== "object" || result === null) && typeof result !== "function") {
      return undefined;
    }
    result = own(result, part);
  }
  return result;
}

function resolve(path: string, context: Context): unknown {
  if (path === "this" || path === ".") return context.current;
  if (path === "@index") return context.index;

  if (path.startsWith("this.")) {
    return walk(context.current, path.slice(5).split("."));
  }

  if (!path) return undefined;
  const parts = path.split(".");
  const local = walk(context.current, parts);
  return local === undefined ? walk(context.root, parts) : local;
}

function isTruthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return value !== "" && value !== 0 && value !== false && value != null;
}

function scalar(value: unknown, node: ValueNode): string {
  if (value == null) return "";
  const kind = typeof value;
  if (kind === "string" || kind === "number" || kind === "boolean" || kind === "bigint") {
    return String(value);
  }
  throw syntaxError(
    `Cannot render non-scalar value for '${node.path || "(empty path)"}'`,
    node.position,
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
  let result = "";

  for (const node of nodes) {
    if (node.type === "text") {
      result += node.value;
      continue;
    }

    if (node.type === "value") {
      const text = scalar(resolve(node.path, context), node);
      result += node.escaped ? escapeHtml(text) : text;
      continue;
    }

    const value = resolve(node.path, context);
    if (node.type === "if") {
      result += renderNodes(isTruthy(value) ? node.body : node.alternate, context);
      continue;
    }

    if (!Array.isArray(value)) {
      result += renderNodes(node.alternate, context);
      continue;
    }
    if (value.length === 0) {
      result += renderNodes(node.alternate, context);
      continue;
    }
    for (let index = 0; index < value.length; index += 1) {
      result += renderNodes(node.body, {
        root: context.root,
        current: value[index],
        index,
      });
    }
  }

  return result;
}

export function render(template: string, data: unknown): string {
  return renderNodes(parse(template), { root: data, current: data, index: undefined });
}
