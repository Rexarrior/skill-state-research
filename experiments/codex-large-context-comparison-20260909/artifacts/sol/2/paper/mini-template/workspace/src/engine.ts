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

type Scope = {
  value: unknown;
  index: number;
};

const hasOwn = (value: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

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

function syntaxError(message: string, position: Position): Error {
  return new Error(`${message} at line ${position.line}, column ${position.column}`);
}

function requirePath(path: string, kind: string, position: Position): string {
  const trimmed = path.trim();
  if (trimmed.length === 0) {
    throw syntaxError(`${kind} requires a path`, position);
  }
  return trimmed;
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

    const position = positionAt(template, opening);
    const triple = template.startsWith("{{{", opening);
    const closingMarker = triple ? "}}}" : "}}";
    const contentStart = opening + (triple ? 3 : 2);
    const closing = template.indexOf(closingMarker, contentStart);

    if (closing === -1) {
      throw syntaxError("Unclosed template tag", position);
    }

    const raw = template.slice(contentStart, closing);
    const tag = raw.trim();
    cursor = closing + closingMarker.length;

    if (triple) {
      output.push({
        type: "value",
        path: requirePath(tag, "Interpolation", position),
        escaped: false,
        position,
      });
      continue;
    }

    if (tag.startsWith("!")) {
      continue;
    }

    if (tag.startsWith("#")) {
      const match = /^#(if|each)(?:\s+([\s\S]*))?$/.exec(tag);
      if (match === null) {
        const name = tag.slice(1).trim().split(/\s+/, 1)[0] || "(empty)";
        throw syntaxError(`Unknown block '${name}'`, position);
      }

      const block: BlockNode = {
        type: match[1] as "if" | "each",
        path: requirePath(match[2] ?? "", `#${match[1]}`, position),
        body: [],
        alternate: [],
        position,
      };
      output.push(block);
      stack.push({ node: block, parent: output, inAlternate: false });
      output = block.body;
      continue;
    }

    if (tag === "else") {
      const current = stack.at(-1);
      if (current === undefined) {
        throw syntaxError("'else' outside a block", position);
      }
      if (current.inAlternate) {
        throw syntaxError("Duplicate 'else'", position);
      }
      current.inAlternate = true;
      output = current.node.alternate;
      continue;
    }

    if (tag.startsWith("/")) {
      const name = tag.slice(1).trim();
      const current = stack.at(-1);
      if (current === undefined) {
        throw syntaxError(`Closing block '/${name}' has no matching opener`, position);
      }
      if (name !== current.node.type) {
        throw syntaxError(
          `Mismatched closing block '/${name}'; expected '/${current.node.type}'`,
          position,
        );
      }
      stack.pop();
      output = current.parent;
      continue;
    }

    output.push({
      type: "value",
      path: requirePath(tag, "Interpolation", position),
      escaped: true,
      position,
    });
  }

  const unclosed = stack.at(-1);
  if (unclosed !== undefined) {
    throw syntaxError(`Unclosed block '#${unclosed.node.type}'`, unclosed.node.position);
  }

  return root;
}

function lookup(base: unknown, parts: string[]): { found: boolean; value: unknown } {
  let value = base;

  for (const part of parts) {
    if ((typeof value !== "object" || value === null) && typeof value !== "function") {
      return { found: false, value: undefined };
    }
    if (!hasOwn(value, part)) {
      return { found: false, value: undefined };
    }
    value = (value as Record<string, unknown>)[part];
  }

  return { found: true, value };
}

function resolve(path: string, root: unknown, scopes: Scope[]): unknown {
  if (path === "this") {
    return scopes.at(-1)?.value;
  }
  if (path === "@index") {
    return scopes.at(-1)?.index;
  }

  if (path.startsWith("this.")) {
    return lookup(scopes.at(-1)?.value, path.slice(5).split(".")).value;
  }

  const parts = path.split(".");
  const current = scopes.at(-1);
  if (current !== undefined) {
    const local = lookup(current.value, parts);
    if (local.found) {
      return local.value;
    }
  }
  return lookup(root, parts).value;
}

function isTruthy(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  return value !== "" && value !== 0 && value !== false && value != null;
}

function scalarText(value: unknown, path: string, position: Position): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  throw syntaxError(`Value at '${path}' cannot be rendered as scalar text`, position);
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

function renderNodes(nodes: Node[], root: unknown, scopes: Scope[]): string {
  let result = "";

  for (const node of nodes) {
    if (node.type === "text") {
      result += node.value;
      continue;
    }

    if (node.type === "value") {
      const text = scalarText(resolve(node.path, root, scopes), node.path, node.position);
      result += node.escaped ? escapeHtml(text) : text;
      continue;
    }

    const value = resolve(node.path, root, scopes);
    if (node.type === "if") {
      result += renderNodes(isTruthy(value) ? node.body : node.alternate, root, scopes);
      continue;
    }

    if (Array.isArray(value) && value.length > 0) {
      for (let index = 0; index < value.length; index += 1) {
        result += renderNodes(node.body, root, [...scopes, { value: value[index], index }]);
      }
    } else {
      result += renderNodes(node.alternate, root, scopes);
    }
  }

  return result;
}

/** Render a Mini Template string with the supplied data. */
export function render(template: string, data: unknown): string {
  return renderNodes(parse(template), data, []);
}
