type Location = {
  offset: number;
  line: number;
  column: number;
};

type TextNode = { type: "text"; value: string };
type ValueNode = { type: "value"; path: string; escaped: boolean; location: Location };
type BlockNode = {
  type: "if" | "each";
  path: string;
  truthy: Node[];
  alternate: Node[];
  location: Location;
};
type Node = TextNode | ValueNode | BlockNode;

type Frame = {
  node: BlockNode;
  parent: Node[];
  inElse: boolean;
};

type LoopContext = { value: unknown; index: number };

const hasOwn = (value: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

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

  return { offset, line, column };
}

function syntaxError(message: string, location: Location): Error {
  return new Error(`${message} at line ${location.line}, column ${location.column}`);
}

function requirePath(path: string, description: string, location: Location): string {
  const trimmed = path.trim();
  if (trimmed.length === 0) {
    throw syntaxError(`${description} requires a path`, location);
  }
  return trimmed;
}

function parse(template: string): Node[] {
  const root: Node[] = [];
  const stack: Frame[] = [];
  let current = root;
  let cursor = 0;

  while (cursor < template.length) {
    const open = template.indexOf("{{", cursor);
    if (open === -1) {
      current.push({ type: "text", value: template.slice(cursor) });
      break;
    }

    if (open > cursor) {
      current.push({ type: "text", value: template.slice(cursor, open) });
    }

    const location = locationAt(template, open);
    const triple = template.startsWith("{{{", open);
    const closeMarker = triple ? "}}}" : "}}";
    const contentStart = open + (triple ? 3 : 2);
    const close = template.indexOf(closeMarker, contentStart);

    if (close === -1) {
      throw syntaxError(`Unclosed ${triple ? "triple interpolation" : "tag"}`, location);
    }

    const content = template.slice(contentStart, close).trim();
    cursor = close + closeMarker.length;

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

    if (content.startsWith("#")) {
      const declaration = content.slice(1).trim();
      const match = /^(if|each)(?:\s+([\s\S]*))?$/.exec(declaration);
      if (!match) {
        const name = declaration.split(/\s/, 1)[0] || "";
        throw syntaxError(`Unknown block '${name}'`, location);
      }

      const node: BlockNode = {
        type: match[1] as "if" | "each",
        path: requirePath(match[2] ?? "", `#${match[1]}`, location),
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
      const frame = stack.at(-1);
      if (!frame) throw syntaxError("Unexpected else outside a block", location);
      if (frame.inElse) throw syntaxError("Duplicate else", location);
      frame.inElse = true;
      current = frame.node.alternate;
      continue;
    }

    if (content.startsWith("/")) {
      const name = content.slice(1).trim();
      if (name !== "if" && name !== "each") {
        throw syntaxError(`Unknown closing block '${name}'`, location);
      }
      const frame = stack.at(-1);
      if (!frame) throw syntaxError(`Unexpected closing block '/${name}'`, location);
      if (frame.node.type !== name) {
        throw syntaxError(
          `Mismatched closing block '/${name}'; expected '/${frame.node.type}'`,
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

function descend(value: unknown, parts: string[]): { found: boolean; value: unknown } {
  let current = value;
  for (const part of parts) {
    if ((typeof current !== "object" || current === null) && typeof current !== "function") {
      return { found: false, value: undefined };
    }
    if (!hasOwn(current, part)) return { found: false, value: undefined };
    current = (current as Record<string, unknown>)[part];
  }
  return { found: true, value: current };
}

function resolve(path: string, root: unknown, loops: LoopContext[]): unknown {
  const parts = path.split(".");
  if (parts.some((part) => part.length === 0)) return undefined;

  const loop = loops.at(-1);
  if (path === "@index") return loop?.index;
  if (parts[0] === "this") return loop ? descend(loop.value, parts.slice(1)).value : undefined;

  if (loop) {
    const local = descend(loop.value, parts);
    if (local.found) return local.value;
  }
  return descend(root, parts).value;
}

function isTruthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return value !== "" && value !== 0 && value !== false && value !== null && value !== undefined;
}

function scalar(value: unknown, path: string, location: Location): string {
  if (value === undefined || value === null) return "";
  switch (typeof value) {
    case "string":
    case "number":
    case "boolean":
    case "bigint":
      return String(value);
    default:
      throw syntaxError(`Value at '${path}' is not renderable as scalar text`, location);
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

function renderNodes(nodes: Node[], root: unknown, loops: LoopContext[]): string {
  let output = "";
  for (const node of nodes) {
    if (node.type === "text") {
      output += node.value;
    } else if (node.type === "value") {
      const text = scalar(resolve(node.path, root, loops), node.path, node.location);
      output += node.escaped ? escapeHtml(text) : text;
    } else if (node.type === "if") {
      const branch = isTruthy(resolve(node.path, root, loops)) ? node.truthy : node.alternate;
      output += renderNodes(branch, root, loops);
    } else {
      const value = resolve(node.path, root, loops);
      if (Array.isArray(value) && value.length > 0) {
        for (let index = 0; index < value.length; index += 1) {
          output += renderNodes(node.truthy, root, [...loops, { value: value[index], index }]);
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
