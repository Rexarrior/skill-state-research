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
  inverse: Node[];
  position: Position;
};
type Node = TextNode | ValueNode | BlockNode;

type OpenBlock = {
  node: BlockNode;
  parent: Node[];
  inElse: boolean;
};

type Context = {
  root: unknown;
  current: unknown;
  index: number | undefined;
  inEach: boolean;
};

const MISSING = Symbol("missing");

function positionAt(template: string, index: number): Position {
  let line = 1;
  let column = 1;
  for (let i = 0; i < index; i++) {
    if (template.charCodeAt(i) === 10) {
      line++;
      column = 1;
    } else {
      column++;
    }
  }
  return { index, line, column };
}

function syntaxError(position: Position, message: string): Error {
  return new Error(
    `Template error at line ${position.line}, column ${position.column}: ${message}`,
  );
}

function requirePath(
  expression: string,
  kind: string,
  position: Position,
): string {
  const path = expression.trim();
  if (!path) throw syntaxError(position, `${kind} requires a path`);
  return path;
}

function parse(template: string): Node[] {
  const root: Node[] = [];
  const stack: OpenBlock[] = [];
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
    const closeToken = triple ? "}}}" : "}}";
    const contentStart = open + (triple ? 3 : 2);
    const close = template.indexOf(closeToken, contentStart);
    const position = positionAt(template, open);
    if (close === -1) {
      throw syntaxError(position, `unclosed ${triple ? "triple" : "double"} tag`);
    }

    const raw = template.slice(contentStart, close);
    const expression = raw.trim();
    cursor = close + closeToken.length;

    if (triple) {
      output.push({
        type: "value",
        path: requirePath(expression, "interpolation", position),
        escaped: false,
        position,
      });
      continue;
    }

    if (expression.startsWith("!")) continue;

    if (expression === "else") {
      const active = stack[stack.length - 1];
      if (!active) throw syntaxError(position, "else outside a block");
      if (active.inElse) throw syntaxError(position, "duplicate else");
      active.inElse = true;
      output = active.node.inverse;
      continue;
    }

    if (expression.startsWith("#")) {
      const match = /^#(\S+)(?:\s+([\s\S]*))?$/.exec(expression);
      const name = match?.[1] ?? expression.slice(1);
      if (name !== "if" && name !== "each") {
        throw syntaxError(position, `unknown block "${name}"`);
      }
      const path = requirePath(match?.[2] ?? "", `${name} block`, position);
      const node: BlockNode = {
        type: name,
        path,
        body: [],
        inverse: [],
        position,
      };
      output.push(node);
      stack.push({ node, parent: output, inElse: false });
      output = node.body;
      continue;
    }

    if (expression.startsWith("/")) {
      const name = expression.slice(1).trim();
      const active = stack[stack.length - 1];
      if (!active) {
        throw syntaxError(position, `closing block "${name}" without an open block`);
      }
      if (name !== active.node.type) {
        throw syntaxError(
          position,
          `mismatched closing block "${name}"; expected "${active.node.type}"`,
        );
      }
      stack.pop();
      output = active.parent;
      continue;
    }

    output.push({
      type: "value",
      path: requirePath(expression, "interpolation", position),
      escaped: true,
      position,
    });
  }

  const unclosed = stack[stack.length - 1];
  if (unclosed) {
    throw syntaxError(
      unclosed.node.position,
      `unclosed ${unclosed.node.type} block`,
    );
  }
  return root;
}

function property(value: unknown, key: string): unknown | typeof MISSING {
  if (value === null || value === undefined) return MISSING;
  if ((typeof value !== "object" && typeof value !== "function") || !(key in value)) {
    return MISSING;
  }
  return (value as Record<string, unknown>)[key];
}

function walk(value: unknown, parts: string[]): unknown | typeof MISSING {
  let result: unknown | typeof MISSING = value;
  for (const part of parts) {
    if (result === MISSING) return MISSING;
    result = property(result, part);
  }
  return result;
}

function resolve(path: string, context: Context): unknown | typeof MISSING {
  if (path === "@index") return context.inEach ? context.index : MISSING;
  if (path === "this") return context.inEach ? context.current : MISSING;
  if (path.startsWith("this.")) {
    return context.inEach
      ? walk(context.current, path.slice(5).split("."))
      : MISSING;
  }

  const parts = path.split(".");
  if (context.inEach) {
    const local = walk(context.current, parts);
    if (local !== MISSING) return local;
  }
  return walk(context.root, parts);
}

function truthy(value: unknown | typeof MISSING): boolean {
  if (value === MISSING || value === null || value === undefined) return false;
  if (value === "" || value === 0 || value === false) return false;
  if (Array.isArray(value) && value.length === 0) return false;
  return true;
}

function scalar(value: unknown | typeof MISSING, position: Position): string {
  if (value === MISSING || value === null || value === undefined) return "";
  switch (typeof value) {
    case "string":
      return value;
    case "number":
    case "bigint":
    case "boolean":
      return String(value);
    default:
      throw syntaxError(
        position,
        `cannot render ${Array.isArray(value) ? "an array" : typeof value} as scalar text`,
      );
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
  let result = "";
  for (const node of nodes) {
    if (node.type === "text") {
      result += node.value;
      continue;
    }
    if (node.type === "value") {
      const text = scalar(resolve(node.path, context), node.position);
      result += node.escaped ? escapeHtml(text) : text;
      continue;
    }

    const value = resolve(node.path, context);
    if (node.type === "if") {
      result += renderNodes(truthy(value) ? node.body : node.inverse, context);
      continue;
    }

    if (Array.isArray(value) && value.length > 0) {
      for (let index = 0; index < value.length; index++) {
        result += renderNodes(node.body, {
          root: context.root,
          current: value[index],
          index,
          inEach: true,
        });
      }
    } else {
      result += renderNodes(node.inverse, context);
    }
  }
  return result;
}

/** Render a Mini Template string using values from data. */
export function render(template: string, data: unknown): string {
  const nodes = parse(template);
  return renderNodes(nodes, {
    root: data,
    current: data,
    index: undefined,
    inEach: false,
  });
}
