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
  consequent: Node[];
  alternate: Node[];
  hasElse: boolean;
  position: Position;
};
type Node = TextNode | ValueNode | BlockNode;

type OpenBlock = {
  node: BlockNode;
  parent: Node[];
};

type LoopContext = {
  value: unknown;
  index: number;
};

const own = (value: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

function positionAt(template: string, offset: number): Position {
  let line = 1;
  let column = 1;
  for (let i = 0; i < offset; i += 1) {
    if (template.charCodeAt(i) === 10) {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { offset, line, column };
}

function syntaxError(message: string, position: Position): Error {
  return new Error(`${message} at line ${position.line}, column ${position.column}`);
}

function requirePath(kind: string, path: string, position: Position): string {
  if (path.length === 0) {
    throw syntaxError(`${kind} requires a path`, position);
  }
  if (path.split(".").some((part) => part.length === 0)) {
    throw syntaxError(`Invalid path \"${path}\"`, position);
  }
  return path;
}

function parse(template: string): Node[] {
  const root: Node[] = [];
  const stack: OpenBlock[] = [];
  let target = root;
  let cursor = 0;

  while (cursor < template.length) {
    const start = template.indexOf("{{", cursor);
    if (start === -1) {
      target.push({ type: "text", value: template.slice(cursor) });
      break;
    }
    if (start > cursor) {
      target.push({ type: "text", value: template.slice(cursor, start) });
    }

    const triple = template.startsWith("{{{", start);
    const close = triple ? "}}}" : "}}";
    const contentStart = start + (triple ? 3 : 2);
    const end = template.indexOf(close, contentStart);
    const position = positionAt(template, start);
    if (end === -1) {
      throw syntaxError(`Unclosed ${triple ? "triple interpolation" : "tag"}`, position);
    }

    const content = template.slice(contentStart, end).trim();
    cursor = end + close.length;

    if (triple) {
      target.push({
        type: "value",
        path: requirePath("Interpolation", content, position),
        escaped: false,
        position,
      });
      continue;
    }

    if (content.startsWith("!")) continue;

    if (content === "else") {
      const open = stack.at(-1);
      if (!open) throw syntaxError("else outside a block", position);
      if (open.node.hasElse) throw syntaxError("Duplicate else", position);
      open.node.hasElse = true;
      target = open.node.alternate;
      continue;
    }

    if (content.startsWith("#")) {
      const match = /^#([^\s]+)(?:\s+(.+))?$/.exec(content);
      const kind = match?.[1];
      if (kind !== "if" && kind !== "each") {
        throw syntaxError(`Unknown block ${kind ? `\"${kind}\"` : "tag"}`, position);
      }
      const path = requirePath(`${kind} block`, match?.[2]?.trim() ?? "", position);
      const node: BlockNode = {
        type: kind,
        path,
        consequent: [],
        alternate: [],
        hasElse: false,
        position,
      };
      target.push(node);
      stack.push({ node, parent: target });
      target = node.consequent;
      continue;
    }

    if (content.startsWith("/")) {
      const kind = content.slice(1).trim();
      if (kind !== "if" && kind !== "each") {
        throw syntaxError(`Unknown closing block \"${kind}\"`, position);
      }
      const open = stack.at(-1);
      if (!open) throw syntaxError(`Closing ${kind} without an open block`, position);
      if (open.node.type !== kind) {
        throw syntaxError(`Mismatched closing block: expected /${open.node.type}, got /${kind}`, position);
      }
      stack.pop();
      target = open.parent;
      continue;
    }

    target.push({
      type: "value",
      path: requirePath("Interpolation", content, position),
      escaped: true,
      position,
    });
  }

  const unclosed = stack.at(-1)?.node;
  if (unclosed) {
    throw syntaxError(`Unclosed ${unclosed.type} block`, unclosed.position);
  }
  return root;
}

function readPath(base: unknown, parts: string[]): { found: boolean; value: unknown } {
  let value = base;
  for (const part of parts) {
    if ((typeof value !== "object" || value === null) && typeof value !== "function") {
      return { found: false, value: undefined };
    }
    if (!own(value, part)) return { found: false, value: undefined };
    value = (value as Record<string, unknown>)[part];
  }
  return { found: true, value };
}

function resolve(path: string, root: unknown, loops: LoopContext[]): unknown {
  const current = loops.at(-1);
  if (path === "this") return current?.value;
  if (path === "@index") return current?.index;

  if (path.startsWith("this.")) {
    return readPath(current?.value, path.slice(5).split(".")).value;
  }

  const parts = path.split(".");
  if (current) {
    const local = readPath(current.value, parts);
    if (local.found) return local.value;
  }
  return readPath(root, parts).value;
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

function renderNodes(nodes: Node[], root: unknown, loops: LoopContext[]): string {
  let output = "";
  for (const node of nodes) {
    if (node.type === "text") {
      output += node.value;
    } else if (node.type === "value") {
      const text = scalar(resolve(node.path, root, loops), node.path, node.position);
      output += node.escaped ? escapeHtml(text) : text;
    } else if (node.type === "if") {
      const branch = isTruthy(resolve(node.path, root, loops)) ? node.consequent : node.alternate;
      output += renderNodes(branch, root, loops);
    } else {
      const value = resolve(node.path, root, loops);
      if (Array.isArray(value) && value.length > 0) {
        for (let index = 0; index < value.length; index += 1) {
          output += renderNodes(node.consequent, root, [...loops, { value: value[index], index }]);
        }
      } else {
        output += renderNodes(node.alternate, root, loops);
      }
    }
  }
  return output;
}

/** Render a Mini Template string with the supplied data. */
export function render(template: string, data: unknown): string {
  return renderNodes(parse(template), data, []);
}
