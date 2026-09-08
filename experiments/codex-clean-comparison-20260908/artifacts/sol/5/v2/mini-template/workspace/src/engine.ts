type Position = {
  offset: number;
  line: number;
  column: number;
};

type TextNode = { kind: "text"; value: string };
type ValueNode = { kind: "value"; path: string; escaped: boolean; position: Position };
type BlockNode = {
  kind: "if" | "each";
  path: string;
  children: Node[];
  alternate: Node[];
  position: Position;
};
type Node = TextNode | ValueNode | BlockNode;

type Frame = {
  node: BlockNode;
  parent: Node[];
  inElse: boolean;
};

type Context = {
  value: unknown;
  index?: number;
};

const own = (value: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

function positionAt(source: string, offset: number): Position {
  let line = 1;
  let column = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source.charCodeAt(index) === 10) {
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

function requirePath(path: string, label: string, position: Position): string {
  if (!path) throw syntaxError(`${label} requires a path`, position);
  return path;
}

function parse(template: string): Node[] {
  const root: Node[] = [];
  const stack: Frame[] = [];
  let target = root;
  let cursor = 0;

  while (cursor < template.length) {
    const open = template.indexOf("{{", cursor);
    if (open === -1) {
      target.push({ kind: "text", value: template.slice(cursor) });
      break;
    }
    if (open > cursor) target.push({ kind: "text", value: template.slice(cursor, open) });

    const position = positionAt(template, open);
    const triple = template.startsWith("{{{", open);
    const closeToken = triple ? "}}}" : "}}";
    const contentStart = open + (triple ? 3 : 2);
    const close = template.indexOf(closeToken, contentStart);
    if (close === -1) throw syntaxError("Unclosed tag", position);

    const content = template.slice(contentStart, close).trim();
    cursor = close + closeToken.length;

    if (triple) {
      if (!content) throw syntaxError("Interpolation requires a path", position);
      target.push({ kind: "value", path: content, escaped: false, position });
      continue;
    }

    if (content.startsWith("!")) continue;

    if (content.startsWith("#")) {
      const expression = content.slice(1).trim();
      const match = /^(if|each)(?:\s+(.*))?$/.exec(expression);
      if (!match) {
        const name = expression.split(/\s/, 1)[0] || "";
        throw syntaxError(`Unknown block ${name ? `\"${name}\"` : "tag"}`, position);
      }
      const kind = match[1] as "if" | "each";
      const path = requirePath((match[2] ?? "").trim(), `#${kind}`, position);
      const node: BlockNode = { kind, path, children: [], alternate: [], position };
      target.push(node);
      stack.push({ node, parent: target, inElse: false });
      target = node.children;
      continue;
    }

    if (content === "else") {
      const frame = stack.at(-1);
      if (!frame) throw syntaxError("else outside a block", position);
      if (frame.inElse) throw syntaxError("Duplicate else", position);
      frame.inElse = true;
      target = frame.node.alternate;
      continue;
    }

    if (content.startsWith("/")) {
      const name = content.slice(1).trim();
      const frame = stack.at(-1);
      if (!frame) throw syntaxError(`Closing block \"${name}\" has no opener`, position);
      if (name !== frame.node.kind) {
        throw syntaxError(
          `Mismatched closing block \"${name}\"; expected \"${frame.node.kind}\"`,
          position,
        );
      }
      stack.pop();
      target = frame.parent;
      continue;
    }

    if (!content) throw syntaxError("Interpolation requires a path", position);
    target.push({ kind: "value", path: content, escaped: true, position });
  }

  const unclosed = stack.at(-1);
  if (unclosed) {
    throw syntaxError(`Unclosed ${unclosed.node.kind} block`, unclosed.node.position);
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

function resolve(path: string, root: unknown, contexts: Context[]): unknown {
  const parts = path.split(".");
  if (parts.some((part) => part.length === 0)) return undefined;

  if (parts[0] === "this") {
    return readPath(contexts.at(-1)?.value, parts.slice(1)).value;
  }
  if (parts[0] === "@index") {
    if (parts.length !== 1) return undefined;
    return contexts.at(-1)?.index;
  }

  if (contexts.length > 0) {
    const local = readPath(contexts.at(-1)?.value, parts);
    if (local.found) return local.value;
  }
  return readPath(root, parts).value;
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
      throw syntaxError(`Value at \"${path}\" is not scalar text`, position);
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

function renderNodes(nodes: Node[], root: unknown, contexts: Context[]): string {
  let output = "";
  for (const node of nodes) {
    if (node.kind === "text") {
      output += node.value;
      continue;
    }
    if (node.kind === "value") {
      const text = scalar(resolve(node.path, root, contexts), node.path, node.position);
      output += node.escaped ? escapeHtml(text) : text;
      continue;
    }

    const value = resolve(node.path, root, contexts);
    if (node.kind === "if") {
      output += renderNodes(isTruthy(value) ? node.children : node.alternate, root, contexts);
    } else if (Array.isArray(value) && value.length > 0) {
      for (let index = 0; index < value.length; index += 1) {
        output += renderNodes(node.children, root, [...contexts, { value: value[index], index }]);
      }
    } else {
      output += renderNodes(node.alternate, root, contexts);
    }
  }
  return output;
}

/** Render a Mini Template string with the supplied data. */
export function render(template: string, data: unknown): string {
  return renderNodes(parse(template), data, []);
}
