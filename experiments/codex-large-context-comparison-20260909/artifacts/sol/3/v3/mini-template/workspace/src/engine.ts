type Location = {
  line: number;
  column: number;
};

type TextNode = { type: "text"; value: string };
type ValueNode = {
  type: "value";
  path: string;
  escaped: boolean;
  location: Location;
};
type BlockNode = {
  type: "if" | "each";
  path: string;
  truthy: Node[];
  alternate: Node[];
  location: Location;
};
type Node = TextNode | ValueNode | BlockNode;

type OpenBlock = {
  node: BlockNode;
  parent: Node[];
  inElse: boolean;
};

type Context = {
  value: unknown;
  index?: number;
};

const MISSING = Symbol("missing");

function locationAt(source: string, offset: number): Location {
  let line = 1;
  let column = 1;
  for (let i = 0; i < offset; i++) {
    if (source.charCodeAt(i) === 10) {
      line++;
      column = 1;
    } else {
      column++;
    }
  }
  return { line, column };
}

function syntaxError(message: string, location: Location): Error {
  return new Error(`${message} at line ${location.line}, column ${location.column}`);
}

function requirePath(path: string, tag: string, location: Location): string {
  if (!path || path.split(".").some((part) => part.length === 0)) {
    throw syntaxError(`Invalid path in ${tag} tag`, location);
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
    const location = locationAt(template, start);
    if (end === -1) {
      throw syntaxError("Unclosed tag", location);
    }

    const content = template.slice(contentStart, end).trim();
    cursor = end + close.length;

    if (triple) {
      current.push({
        type: "value",
        path: requirePath(content, "interpolation", location),
        escaped: false,
        location,
      });
      continue;
    }

    if (content.startsWith("!")) continue;

    if (content.startsWith("#")) {
      const match = /^#(if|each)(?:\s+(.+))?$/.exec(content);
      if (!match) {
        const name = content.slice(1).trim().split(/\s+/, 1)[0] || "(empty)";
        throw syntaxError(`Unknown block '${name}'`, location);
      }
      const kind = match[1] as "if" | "each";
      const node: BlockNode = {
        type: kind,
        path: requirePath(match[2]?.trim() ?? "", `#${kind}`, location),
        truthy: [],
        alternate: [],
        location,
      };
      current.push(node);
      stack.push({ node, parent: current, inElse: false });
      current = node.truthy;
      continue;
    }

    if (content === "else") {
      const open = stack.at(-1);
      if (!open) throw syntaxError("'else' outside a block", location);
      if (open.inElse) throw syntaxError("Duplicate 'else'", location);
      open.inElse = true;
      current = open.node.alternate;
      continue;
    }

    if (content.startsWith("/")) {
      const name = content.slice(1).trim();
      const open = stack.at(-1);
      if (!open) throw syntaxError(`Unexpected closing block '/${name}'`, location);
      if (name !== open.node.type) {
        throw syntaxError(
          `Mismatched closing block: expected '/${open.node.type}', got '/${name}'`,
          location,
        );
      }
      stack.pop();
      current = open.parent;
      continue;
    }

    current.push({
      type: "value",
      path: requirePath(content, "interpolation", location),
      escaped: true,
      location,
    });
  }

  const unclosed = stack.at(-1);
  if (unclosed) {
    throw syntaxError(`Unclosed '${unclosed.node.type}' block`, unclosed.node.location);
  }
  return root;
}

function descend(value: unknown, parts: string[]): unknown | typeof MISSING {
  let current = value;
  for (const part of parts) {
    if ((typeof current !== "object" || current === null) && typeof current !== "function") {
      return MISSING;
    }
    if (!Object.prototype.hasOwnProperty.call(current, part)) return MISSING;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function resolve(path: string, root: unknown, context?: Context): unknown | typeof MISSING {
  const parts = path.split(".");
  if (parts[0] === "this") {
    if (!context) return MISSING;
    return parts.length === 1 ? context.value : descend(context.value, parts.slice(1));
  }
  if (parts[0] === "@index") {
    if (!context || parts.length !== 1) return MISSING;
    return context.index;
  }
  if (context) {
    const local = descend(context.value, parts);
    if (local !== MISSING) return local;
  }
  return descend(root, parts);
}

function isTruthy(value: unknown | typeof MISSING): boolean {
  if (value === MISSING || value == null || value === false || value === 0 || value === "") {
    return false;
  }
  return !Array.isArray(value) || value.length > 0;
}

function scalarText(value: unknown | typeof MISSING, path: string, location: Location): string {
  if (value === MISSING || value == null) return "";
  if (typeof value === "object" || typeof value === "function") {
    throw syntaxError(`Cannot render non-scalar value at path '${path}'`, location);
  }
  return String(value);
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

function renderNodes(nodes: Node[], root: unknown, context?: Context): string {
  let output = "";
  for (const node of nodes) {
    if (node.type === "text") {
      output += node.value;
    } else if (node.type === "value") {
      const text = scalarText(resolve(node.path, root, context), node.path, node.location);
      output += node.escaped ? escapeHtml(text) : text;
    } else if (node.type === "if") {
      const branch = isTruthy(resolve(node.path, root, context)) ? node.truthy : node.alternate;
      output += renderNodes(branch, root, context);
    } else {
      const value = resolve(node.path, root, context);
      if (Array.isArray(value) && value.length > 0) {
        for (let index = 0; index < value.length; index++) {
          output += renderNodes(node.truthy, root, { value: value[index], index });
        }
      } else {
        output += renderNodes(node.alternate, root, context);
      }
    }
  }
  return output;
}

/** Render a Mini Template string using values from data. */
export function render(template: string, data: unknown): string {
  return renderNodes(parse(template), data);
}
