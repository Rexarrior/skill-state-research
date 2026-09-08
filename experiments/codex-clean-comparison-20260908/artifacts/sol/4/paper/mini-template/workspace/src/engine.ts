type Position = { offset: number; line: number; column: number };

type TextNode = { kind: "text"; value: string };
type ValueNode = { kind: "value"; path: string; escaped: boolean; position: Position };
type BlockNode = {
  kind: "if" | "each";
  path: string;
  body: Node[];
  alternate: Node[];
  position: Position;
};
type Node = TextNode | ValueNode | BlockNode;

type Token =
  | { kind: "text"; value: string; position: Position }
  | { kind: "tag"; value: string; triple: boolean; position: Position };

type Context = { value: unknown; index?: number; parent?: Context };

function positionAt(source: string, offset: number): Position {
  let line = 1;
  let column = 1;
  for (let i = 0; i < offset; i++) {
    if (source[i] === "\n") {
      line++;
      column = 1;
    } else {
      column++;
    }
  }
  return { offset, line, column };
}

function syntaxError(message: string, position: Position): Error {
  return new Error(`${message} at line ${position.line}, column ${position.column}`);
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let cursor = 0;

  while (cursor < source.length) {
    const start = source.indexOf("{{", cursor);
    if (start === -1) {
      tokens.push({ kind: "text", value: source.slice(cursor), position: positionAt(source, cursor) });
      break;
    }
    if (start > cursor) {
      tokens.push({ kind: "text", value: source.slice(cursor, start), position: positionAt(source, cursor) });
    }

    const triple = source.startsWith("{{{", start);
    const closing = triple ? "}}}" : "}}";
    const contentStart = start + (triple ? 3 : 2);
    const end = source.indexOf(closing, contentStart);
    if (end === -1) {
      throw syntaxError("Unclosed tag", positionAt(source, start));
    }
    tokens.push({
      kind: "tag",
      value: source.slice(contentStart, end).trim(),
      triple,
      position: positionAt(source, start),
    });
    cursor = end + closing.length;
  }

  return tokens;
}

function parse(source: string): Node[] {
  const tokens = tokenize(source);
  let cursor = 0;

  function parseSequence(expected?: "if" | "each", opening?: Position): { nodes: Node[]; endedBy: "else" | "close" | "eof" } {
    const nodes: Node[] = [];

    while (cursor < tokens.length) {
      const token = tokens[cursor++]!;
      if (token.kind === "text") {
        nodes.push({ kind: "text", value: token.value });
        continue;
      }

      const tag = token.value;
      if (tag === "else") {
        if (!expected) throw syntaxError("'else' outside a block", token.position);
        return { nodes, endedBy: "else" };
      }

      if (tag.startsWith("/")) {
        const name = tag.slice(1).trim();
        if (!expected) throw syntaxError(`Unexpected closing block '${name}'`, token.position);
        if (name !== expected) {
          throw syntaxError(`Mismatched closing block '${name}'; expected '${expected}'`, token.position);
        }
        return { nodes, endedBy: "close" };
      }

      if (tag.startsWith("#")) {
        const match = /^#(if|each)\s+(.+)$/.exec(tag);
        if (!match) {
          const name = tag.slice(1).trim().split(/\s+/, 1)[0] || "";
          throw syntaxError(`Unknown or invalid block '${name}'`, token.position);
        }
        const kind = match[1] as "if" | "each";
        const path = match[2]!.trim();
        if (!path) throw syntaxError(`Block '${kind}' requires a path`, token.position);

        const body = parseSequence(kind, token.position);
        let alternate: Node[] = [];
        if (body.endedBy === "else") {
          const rest = parseSequence(kind, token.position);
          if (rest.endedBy === "else") throw syntaxError("Duplicate 'else' in block", tokens[cursor - 1]!.position);
          if (rest.endedBy === "eof") throw syntaxError(`Unclosed '${kind}' block`, token.position);
          alternate = rest.nodes;
        } else if (body.endedBy === "eof") {
          throw syntaxError(`Unclosed '${kind}' block`, token.position);
        }
        nodes.push({ kind, path, body: body.nodes, alternate, position: token.position });
        continue;
      }

      if (tag.startsWith("!")) continue;
      if (tag === "") throw syntaxError("Empty tag", token.position);
      nodes.push({ kind: "value", path: tag, escaped: !token.triple, position: token.position });
    }

    if (expected && opening) return { nodes, endedBy: "eof" };
    return { nodes, endedBy: "eof" };
  }

  return parseSequence().nodes;
}

function own(object: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
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

function resolve(path: string, context: Context, root: unknown): unknown {
  if (path === "this") return context.value;
  if (path === "@index") return context.index;

  if (path.startsWith("this.")) {
    return readPath(context.value, path.slice(5).split(".")).value;
  }

  const parts = path.split(".");
  const local = readPath(context.value, parts);
  if (local.found) return local.value;
  return readPath(root, parts).value;
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
      throw syntaxError(`Value '${path}' is not renderable as scalar text`, position);
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

function renderNodes(nodes: Node[], context: Context, root: unknown): string {
  let output = "";
  for (const node of nodes) {
    if (node.kind === "text") {
      output += node.value;
    } else if (node.kind === "value") {
      const text = scalar(resolve(node.path, context, root), node.path, node.position);
      output += node.escaped ? escapeHtml(text) : text;
    } else if (node.kind === "if") {
      const branch = truthy(resolve(node.path, context, root)) ? node.body : node.alternate;
      output += renderNodes(branch, context, root);
    } else {
      const value = resolve(node.path, context, root);
      if (Array.isArray(value) && value.length > 0) {
        for (let index = 0; index < value.length; index++) {
          output += renderNodes(node.body, { value: value[index], index, parent: context }, root);
        }
      } else {
        output += renderNodes(node.alternate, context, root);
      }
    }
  }
  return output;
}

/** Render a Mini Template string with the supplied data. */
export function render(template: string, data: unknown): string {
  const nodes = parse(template);
  return renderNodes(nodes, { value: data }, data);
}
