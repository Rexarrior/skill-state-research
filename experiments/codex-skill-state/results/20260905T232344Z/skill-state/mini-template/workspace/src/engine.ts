type Location = {
  line: number;
  column: number;
};

type Node =
  | { type: "text"; value: string }
  | { type: "value"; path: string; escaped: boolean; location: Location }
  | {
      type: "if" | "each";
      path: string;
      body: Node[];
      alternate: Node[];
      location: Location;
    };

type BlockNode = Extract<Node, { type: "if" | "each" }>;

type Frame = {
  node: BlockNode;
  parent: Node[];
  inElse: boolean;
};

type Context = {
  root: unknown;
  items: Array<{ value: unknown; index: number }>;
};

const MISSING = Symbol("missing");

function locationAt(source: string, offset: number): Location {
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

function syntaxError(message: string, location: Location): Error {
  return new Error(`${message} at line ${location.line}, column ${location.column}`);
}

function requirePath(path: string, kind: string, location: Location): string {
  if (path.length === 0) {
    throw syntaxError(`${kind} requires a path`, location);
  }
  return path;
}

function parse(template: string): Node[] {
  const root: Node[] = [];
  const stack: Frame[] = [];
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
    const closing = triple ? "}}}" : "}}";
    const contentStart = start + (triple ? 3 : 2);
    const end = template.indexOf(closing, contentStart);
    const location = locationAt(template, start);
    if (end === -1) {
      throw syntaxError("Unclosed template tag", location);
    }

    const content = template.slice(contentStart, end).trim();
    cursor = end + closing.length;

    if (triple) {
      current.push({
        type: "value",
        path: requirePath(content, "Interpolation", location),
        escaped: false,
        location,
      });
      continue;
    }

    if (content.startsWith("!")) continue;

    if (content === "else") {
      const frame = stack.at(-1);
      if (!frame) throw syntaxError("Unexpected else outside a block", location);
      if (frame.inElse) throw syntaxError("Duplicate else", location);
      frame.inElse = true;
      current = frame.node.alternate;
      continue;
    }

    if (content.startsWith("#")) {
      const match = /^#(if|each)(?:\s+(.+))?$/.exec(content);
      if (!match) {
        const name = content.slice(1).split(/\s/, 1)[0] || "(empty)";
        throw syntaxError(`Unknown block '${name}'`, location);
      }
      const type = match[1] as "if" | "each";
      const node: BlockNode = {
        type,
        path: requirePath(match[2]?.trim() ?? "", `#${type}`, location),
        body: [],
        alternate: [],
        location,
      };
      current.push(node);
      stack.push({ node, parent: current, inElse: false });
      current = node.body;
      continue;
    }

    if (content.startsWith("/")) {
      const name = content.slice(1).trim();
      const frame = stack.at(-1);
      if (!frame) throw syntaxError(`Unexpected closing block '/${name}'`, location);
      if (name !== frame.node.type) {
        throw syntaxError(
          `Mismatched closing block: expected '/${frame.node.type}', got '/${name}'`,
          location,
        );
      }
      stack.pop();
      current = frame.parent;
      continue;
    }

    current.push({
      type: "value",
      path: requirePath(content, "Interpolation", location),
      escaped: true,
      location,
    });
  }

  const unclosed = stack.at(-1);
  if (unclosed) {
    throw syntaxError(`Unclosed block '#${unclosed.node.type}'`, unclosed.node.location);
  }
  return root;
}

function lookup(value: unknown, path: string): unknown | typeof MISSING {
  let current = value;
  for (const part of path.split(".")) {
    if (
      current === null ||
      current === undefined ||
      (typeof current !== "object" && typeof current !== "function") ||
      !Object.prototype.hasOwnProperty.call(current, part)
    ) {
      return MISSING;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function resolve(path: string, context: Context): unknown | typeof MISSING {
  const active = context.items.at(-1);
  if (path === "this") return active ? active.value : context.root;
  if (path.startsWith("this.")) {
    return lookup(active ? active.value : context.root, path.slice(5));
  }
  if (path === "@index") return active ? active.index : MISSING;
  if (path.startsWith("@")) return MISSING;

  if (active) {
    const local = lookup(active.value, path);
    if (local !== MISSING) return local;
  }
  return lookup(context.root, path);
}

function isTruthy(value: unknown | typeof MISSING): boolean {
  if (value === MISSING || value === null || value === undefined) return false;
  if (value === false || value === 0 || value === "") return false;
  if (Array.isArray(value) && value.length === 0) return false;
  return true;
}

function scalarText(value: unknown | typeof MISSING, path: string, location: Location): string {
  if (value === MISSING || value === null || value === undefined) return "";
  switch (typeof value) {
    case "string":
      return value;
    case "number":
    case "bigint":
    case "boolean":
      return String(value);
    default:
      throw syntaxError(`Value '${path}' is not scalar and cannot be rendered`, location);
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
  let output = "";
  for (const node of nodes) {
    if (node.type === "text") {
      output += node.value;
    } else if (node.type === "value") {
      const text = scalarText(resolve(node.path, context), node.path, node.location);
      output += node.escaped ? escapeHtml(text) : text;
    } else if (node.type === "if") {
      const branch = isTruthy(resolve(node.path, context)) ? node.body : node.alternate;
      output += renderNodes(branch, context);
    } else {
      const value = resolve(node.path, context);
      if (Array.isArray(value) && value.length > 0) {
        value.forEach((item, index) => {
          context.items.push({ value: item, index });
          try {
            output += renderNodes(node.body, context);
          } finally {
            context.items.pop();
          }
        });
      } else {
        output += renderNodes(node.alternate, context);
      }
    }
  }
  return output;
}

/** Render a Mini Template string using values from data. */
export function render(template: string, data: unknown): string {
  return renderNodes(parse(template), { root: data, items: [] });
}
