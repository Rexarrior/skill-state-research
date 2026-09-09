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
  alternate: Node[] | null;
  position: Position;
};
type Node = TextNode | ValueNode | BlockNode;

type OpenBlock = {
  node: BlockNode;
  parent: Node[];
};

type Scope = {
  value: unknown;
  index: number;
};

const MISSING = Symbol("missing");

function positionAt(template: string, offset: number): Position {
  let line = 1;
  let column = 1;
  for (let i = 0; i < offset; i++) {
    if (template.charCodeAt(i) === 10) {
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

function requirePath(path: string, kind: string, position: Position): string {
  if (path.length === 0) {
    throw syntaxError(`${kind} requires a path`, position);
  }
  return path;
}

function parse(template: string): Node[] {
  const root: Node[] = [];
  const stack: OpenBlock[] = [];
  let current = root;
  let cursor = 0;

  while (cursor < template.length) {
    const start = template.indexOf("{{", cursor);
    if (start === -1) {
      current.push({ type: "text", value: template.slice(cursor) });
      break;
    }
    if (start > cursor) {
      current.push({ type: "text", value: template.slice(cursor, start) });
    }

    const triple = template.startsWith("{{{", start);
    const close = triple ? "}}}" : "}}";
    const contentStart = start + (triple ? 3 : 2);
    const end = template.indexOf(close, contentStart);
    const position = positionAt(template, start);
    if (end === -1) {
      throw syntaxError("Unclosed tag", position);
    }

    const tag = template.slice(contentStart, end).trim();
    cursor = end + close.length;

    if (triple) {
      current.push({
        type: "value",
        path: requirePath(tag, "Interpolation", position),
        escaped: false,
        position,
      });
      continue;
    }

    if (tag.startsWith("!")) continue;

    if (tag.startsWith("#")) {
      const opening = tag.slice(1).trim();
      const space = opening.search(/\s/);
      const kind = space === -1 ? opening : opening.slice(0, space);
      const path = space === -1 ? "" : opening.slice(space).trim();
      if (kind !== "if" && kind !== "each") {
        throw syntaxError(`Unknown block \"${kind || opening}\"`, position);
      }
      const node: BlockNode = {
        type: kind,
        path: requirePath(path, `#${kind}`, position),
        body: [],
        alternate: null,
        position,
      };
      current.push(node);
      stack.push({ node, parent: current });
      current = node.body;
      continue;
    }

    if (tag === "else") {
      const open = stack.at(-1);
      if (!open) throw syntaxError("else outside a block", position);
      if (open.node.alternate !== null) {
        throw syntaxError("Duplicate else", position);
      }
      open.node.alternate = [];
      current = open.node.alternate;
      continue;
    }

    if (tag.startsWith("/")) {
      const kind = tag.slice(1).trim();
      if (kind !== "if" && kind !== "each") {
        throw syntaxError(`Unknown closing block \"${kind}\"`, position);
      }
      const open = stack.at(-1);
      if (!open) {
        throw syntaxError(`Closing /${kind} without an open block`, position);
      }
      if (open.node.type !== kind) {
        throw syntaxError(
          `Mismatched closing /${kind}; expected /${open.node.type}`,
          position,
        );
      }
      stack.pop();
      current = open.parent;
      continue;
    }

    current.push({
      type: "value",
      path: requirePath(tag, "Interpolation", position),
      escaped: true,
      position,
    });
  }

  const unclosed = stack.at(-1);
  if (unclosed) {
    throw syntaxError(`Unclosed #${unclosed.node.type} block`, unclosed.node.position);
  }
  return root;
}

function property(value: unknown, key: string): unknown | typeof MISSING {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") {
    return MISSING;
  }
  if (!Object.prototype.hasOwnProperty.call(value, key)) return MISSING;
  return (value as Record<string, unknown>)[key];
}

function traverse(value: unknown, segments: string[]): unknown | typeof MISSING {
  let result: unknown | typeof MISSING = value;
  for (const segment of segments) {
    result = property(result, segment);
    if (result === MISSING) return MISSING;
  }
  return result;
}

function resolve(path: string, root: unknown, scopes: Scope[]): unknown {
  const segments = path.split(".");
  const scope = scopes.at(-1);

  if (segments[0] === "this") {
    if (!scope) return undefined;
    const result = traverse(scope.value, segments.slice(1));
    return result === MISSING ? undefined : result;
  }
  if (segments[0] === "@index") {
    if (!scope || segments.length !== 1) return undefined;
    return scope.index;
  }

  if (scope) {
    const local = traverse(scope.value, segments);
    if (local !== MISSING) return local;
  }
  const result = traverse(root, segments);
  return result === MISSING ? undefined : result;
}

function isTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === "") return false;
  if (value === 0 || value === 0n) return false;
  if (Array.isArray(value) && value.length === 0) return false;
  return true;
}

function scalar(value: unknown, path: string, position: Position): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object" || typeof value === "function") {
    throw syntaxError(`Value at \"${path}\" is not scalar text`, position);
  }
  return String(value);
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
  let output = "";
  for (const node of nodes) {
    if (node.type === "text") {
      output += node.value;
      continue;
    }
    if (node.type === "value") {
      const text = scalar(resolve(node.path, root, scopes), node.path, node.position);
      output += node.escaped ? escapeHtml(text) : text;
      continue;
    }

    const value = resolve(node.path, root, scopes);
    if (node.type === "if") {
      const branch = isTruthy(value) ? node.body : node.alternate;
      if (branch) output += renderNodes(branch, root, scopes);
      continue;
    }

    if (Array.isArray(value) && value.length > 0) {
      for (let index = 0; index < value.length; index++) {
        output += renderNodes(node.body, root, [...scopes, { value: value[index], index }]);
      }
    } else if (node.alternate) {
      output += renderNodes(node.alternate, root, scopes);
    }
  }
  return output;
}

/** Render a Mini Template string with the supplied data. */
export function render(template: string, data: unknown): string {
  return renderNodes(parse(template), data, []);
}
