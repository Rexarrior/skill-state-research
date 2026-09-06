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
  consequent: Node[];
  alternate: Node[];
  position: Position;
};
type Node = TextNode | ValueNode | BlockNode;

type Frame = {
  block: BlockNode;
  parent: Node[];
  inElse: boolean;
};

type Scope = { value: unknown; index: number };

const MISSING = Symbol("missing");

function location(source: string, index: number): Position {
  let line = 1;
  let column = 1;

  for (let cursor = 0; cursor < index; cursor++) {
    if (source.charCodeAt(cursor) === 10) {
      line++;
      column = 1;
    } else {
      column++;
    }
  }

  return { index, line, column };
}

function syntaxError(message: string, position: Position): Error {
  return new Error(`${message} at line ${position.line}, column ${position.column}`);
}

function requirePath(path: string, kind: string, position: Position): string {
  if (!path) throw syntaxError(`${kind} requires a path`, position);
  return path;
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

    if (start > cursor) {
      output.push({ type: "text", value: template.slice(cursor, start) });
    }

    const triple = template.startsWith("{{{", start);
    const close = triple ? "}}}" : "}}";
    const contentStart = start + (triple ? 3 : 2);
    const end = template.indexOf(close, contentStart);
    const position = location(template, start);

    if (end === -1) throw syntaxError("Unclosed tag", position);

    const content = template.slice(contentStart, end).trim();
    cursor = end + close.length;

    if (triple) {
      output.push({
        type: "value",
        path: requirePath(content, "Interpolation", position),
        escaped: false,
        position,
      });
      continue;
    }

    if (content.startsWith("!")) continue;

    if (content.startsWith("#")) {
      const declaration = content.slice(1).trim();
      const match = /^(if|each)(?:\s+(.+))?$/.exec(declaration);
      if (!match) {
        const name = declaration.split(/\s/, 1)[0] || "(empty)";
        throw syntaxError(`Unknown block \"${name}\"`, position);
      }

      const block: BlockNode = {
        type: match[1] as "if" | "each",
        path: requirePath(match[2]?.trim() ?? "", `#${match[1]}`, position),
        consequent: [],
        alternate: [],
        position,
      };
      output.push(block);
      stack.push({ block, parent: output, inElse: false });
      output = block.consequent;
      continue;
    }

    if (content === "else") {
      const frame = stack.at(-1);
      if (!frame) throw syntaxError("else outside a block", position);
      if (frame.inElse) throw syntaxError("Duplicate else", position);
      frame.inElse = true;
      output = frame.block.alternate;
      continue;
    }

    if (content.startsWith("/")) {
      const name = content.slice(1).trim();
      const frame = stack.at(-1);
      if (!frame) throw syntaxError(`Closing /${name || "(empty)"} without an open block`, position);
      if (name !== frame.block.type) {
        throw syntaxError(`Mismatched close /${name || "(empty)"}; expected /${frame.block.type}`, position);
      }
      stack.pop();
      output = frame.parent;
      continue;
    }

    output.push({
      type: "value",
      path: requirePath(content, "Interpolation", position),
      escaped: true,
      position,
    });
  }

  const unclosed = stack.at(-1)?.block;
  if (unclosed) throw syntaxError(`Unclosed #${unclosed.type} block`, unclosed.position);
  return root;
}

function own(object: object, key: string): unknown | typeof MISSING {
  if (!Object.prototype.hasOwnProperty.call(object, key)) return MISSING;
  return (object as Record<string, unknown>)[key];
}

function descend(value: unknown, parts: string[]): unknown | typeof MISSING {
  let current = value;
  for (const part of parts) {
    if ((typeof current !== "object" || current === null) && typeof current !== "function") {
      return MISSING;
    }
    current = own(current, part);
    if (current === MISSING) return MISSING;
  }
  return current;
}

function resolve(path: string, root: unknown, scopes: Scope[]): unknown | typeof MISSING {
  if (path === "@index") return scopes.at(-1)?.index ?? MISSING;
  if (path === "this") return scopes.at(-1)?.value ?? root;
  if (path.startsWith("this.")) {
    const base = scopes.at(-1)?.value ?? root;
    return descend(base, path.slice(5).split("."));
  }

  const parts = path.split(".");
  for (let index = scopes.length - 1; index >= 0; index--) {
    const value = descend(scopes[index].value, parts);
    if (value !== MISSING) return value;
  }
  return descend(root, parts);
}

function truthy(value: unknown | typeof MISSING): boolean {
  if (value === MISSING || value === null || value === undefined) return false;
  if (value === false || value === 0 || value === "") return false;
  if (Array.isArray(value) && value.length === 0) return false;
  return true;
}

function scalar(value: unknown | typeof MISSING, path: string, position: Position): string {
  if (value === MISSING || value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  throw syntaxError(`Value at \"${path}\" cannot be rendered as scalar text`, position);
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

function renderNodes(nodes: Node[], root: unknown, scopes: Scope[]): string {
  let result = "";

  for (const node of nodes) {
    if (node.type === "text") {
      result += node.value;
      continue;
    }

    const value = resolve(node.path, root, scopes);
    if (node.type === "value") {
      const text = scalar(value, node.path, node.position);
      result += node.escaped ? escapeHtml(text) : text;
    } else if (node.type === "if") {
      result += renderNodes(truthy(value) ? node.consequent : node.alternate, root, scopes);
    } else if (Array.isArray(value) && value.length > 0) {
      for (let index = 0; index < value.length; index++) {
        result += renderNodes(node.consequent, root, [...scopes, { value: value[index], index }]);
      }
    } else {
      result += renderNodes(node.alternate, root, scopes);
    }
  }

  return result;
}

export function render(template: string, data: unknown): string {
  return renderNodes(parse(template), data, []);
}
