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
  body: Node[];
  alternate: Node[];
  position: Position;
};
type Node = TextNode | ValueNode | BlockNode;

type OpenBlock = {
  node: BlockNode;
  parent: Node[];
  inAlternate: boolean;
};

type RenderContext = {
  root: unknown;
  current: unknown;
  index: number | undefined;
};

const MISSING = Symbol("missing");

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

/** Render a Mini Template string with the supplied data. */
export function render(template: string, data: unknown): string {
  if (typeof template !== "string") {
    throw new TypeError("template must be a string");
  }

  const nodes = parse(template);
  return renderNodes(nodes, { root: data, current: data, index: undefined });
}

function parse(template: string): Node[] {
  const root: Node[] = [];
  const stack: OpenBlock[] = [];
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
    const closingText = triple ? "}}}" : "}}";
    const contentStart = opening + (triple ? 3 : 2);
    const closing = template.indexOf(closingText, contentStart);
    const position = positionAt(template, opening);

    if (closing === -1) {
      throw new TemplateError("Unclosed tag", position);
    }

    const content = template.slice(contentStart, closing).trim();
    cursor = closing + closingText.length;

    if (triple) {
      assertPath(content, position);
      output.push({ type: "value", path: content, escaped: false, position });
      continue;
    }

    if (content.startsWith("!")) continue;

    if (content === "else") {
      const active = stack.at(-1);
      if (!active) throw new TemplateError("'else' outside a block", position);
      if (active.inAlternate) throw new TemplateError("Duplicate 'else'", position);
      active.inAlternate = true;
      output = active.node.alternate;
      continue;
    }

    if (content.startsWith("#")) {
      const match = /^#(if|each)\s+(.+)$/.exec(content);
      if (!match) {
        const name = content.slice(1).trim().split(/\s+/, 1)[0] || "(empty)";
        throw new TemplateError(`Unknown or invalid block '${name}'`, position);
      }
      const kind = match[1] as "if" | "each";
      const path = match[2].trim();
      assertPath(path, position);
      const node: BlockNode = {
        type: kind,
        path,
        body: [],
        alternate: [],
        position,
      };
      output.push(node);
      stack.push({ node, parent: output, inAlternate: false });
      output = node.body;
      continue;
    }

    if (content.startsWith("/")) {
      const name = content.slice(1).trim();
      const active = stack.at(-1);
      if (!active) throw new TemplateError(`Closing '${name}' without an open block`, position);
      if (name !== active.node.type) {
        throw new TemplateError(
          `Mismatched closing block: expected '/${active.node.type}', got '/${name}'`,
          position,
        );
      }
      stack.pop();
      output = active.parent;
      continue;
    }

    assertPath(content, position);
    output.push({ type: "value", path: content, escaped: true, position });
  }

  const unclosed = stack.at(-1);
  if (unclosed) {
    throw new TemplateError(`Unclosed '${unclosed.node.type}' block`, unclosed.node.position);
  }
  return root;
}

function assertPath(path: string, position: Position): void {
  if (!path) throw new TemplateError("Empty expression", position);
  if (/\s/.test(path)) throw new TemplateError(`Invalid path '${path}'`, position);
  if (path !== "this" && path !== "@index" && path.split(".").some((part) => !part)) {
    throw new TemplateError(`Invalid path '${path}'`, position);
  }
}

function renderNodes(nodes: Node[], context: RenderContext): string {
  let result = "";
  for (const node of nodes) {
    if (node.type === "text") {
      result += node.value;
      continue;
    }

    const value = resolve(node.path, context);
    if (node.type === "value") {
      const text = scalarToString(value, node.path, node.position);
      result += node.escaped ? escapeHtml(text) : text;
      continue;
    }

    if (node.type === "if") {
      result += renderNodes(isTruthy(value) ? node.body : node.alternate, context);
      continue;
    }

    if (Array.isArray(value) && value.length > 0) {
      for (let index = 0; index < value.length; index += 1) {
        result += renderNodes(node.body, {
          root: context.root,
          current: value[index],
          index,
        });
      }
    } else {
      result += renderNodes(node.alternate, context);
    }
  }
  return result;
}

function resolve(path: string, context: RenderContext): unknown {
  if (path === "this") return context.current;
  if (path.startsWith("this.")) {
    const value = lookup(context.current, path.slice(5));
    return value === MISSING ? undefined : value;
  }
  if (path === "@index") return context.index;

  const local = lookup(context.current, path);
  if (local !== MISSING) return local;
  const root = lookup(context.root, path);
  return root === MISSING ? undefined : root;
}

function lookup(source: unknown, path: string): unknown | typeof MISSING {
  let value = source;
  for (const part of path.split(".")) {
    if ((typeof value !== "object" || value === null) && typeof value !== "function") {
      return MISSING;
    }
    if (!Object.prototype.hasOwnProperty.call(value, part)) return MISSING;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

function scalarToString(value: unknown, path: string, position: Position): string {
  if (value === null || value === undefined || value === MISSING) return "";
  switch (typeof value) {
    case "string":
      return value;
    case "number":
    case "bigint":
    case "boolean":
      return String(value);
    default:
      throw new TemplateError(`Value at '${path}' is not scalar text`, position);
  }
}

function isTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === "") return false;
  if (value === 0 || value === 0n) return false;
  if (Array.isArray(value) && value.length === 0) return false;
  return true;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function positionAt(template: string, index: number): Position {
  let line = 1;
  let column = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (template[cursor] === "\n") {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { index, line, column };
}
