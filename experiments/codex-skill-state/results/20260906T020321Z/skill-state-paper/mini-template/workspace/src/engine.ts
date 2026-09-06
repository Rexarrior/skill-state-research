type Position = {
  line: number;
  column: number;
};

type Node =
  | { type: "text"; value: string }
  | { type: "value"; path: string; escaped: boolean; position: Position }
  | {
      type: "if";
      path: string;
      then: Node[];
      otherwise: Node[];
      position: Position;
    }
  | {
      type: "each";
      path: string;
      body: Node[];
      otherwise: Node[];
      position: Position;
    };

type BlockNode = Extract<Node, { type: "if" | "each" }>;

type Frame = {
  node: BlockNode;
  parent: Node[];
  inElse: boolean;
};

type Context = {
  value: unknown;
  index: number;
};

export class TemplateError extends Error {
  readonly line: number;
  readonly column: number;

  constructor(message: string, position: Position) {
    super(`${message} at line ${position.line}, column ${position.column}`);
    this.name = "TemplateError";
    this.line = position.line;
    this.column = position.column;
  }
}

function positionAt(source: string, offset: number): Position {
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

function requirePath(path: string, kind: string, position: Position): string {
  if (!path) {
    throw new TemplateError(`${kind} requires a path`, position);
  }
  if (path.split(".").some((part) => part.length === 0)) {
    throw new TemplateError(`Invalid path "${path}"`, position);
  }
  return path;
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

    const position = positionAt(template, open);
    const triple = template.startsWith("{{{", open);
    const closeToken = triple ? "}}}" : "}}";
    const contentStart = open + (triple ? 3 : 2);
    const close = template.indexOf(closeToken, contentStart);
    if (close === -1) {
      throw new TemplateError("Unclosed tag", position);
    }

    const tag = template.slice(contentStart, close).trim();
    cursor = close + closeToken.length;

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
      const match = /^#(if|each)(?:\s+(.+?))?$/.exec(tag);
      if (!match) {
        const name = tag.slice(1).split(/\s/, 1)[0] || tag;
        throw new TemplateError(`Unknown block "${name}"`, position);
      }

      const type = match[1] as "if" | "each";
      const path = requirePath(match[2]?.trim() ?? "", `#${type}`, position);
      const node: BlockNode =
        type === "if"
          ? { type, path, then: [], otherwise: [], position }
          : { type, path, body: [], otherwise: [], position };
      current.push(node);
      stack.push({ node, parent: current, inElse: false });
      current = node.type === "if" ? node.then : node.body;
      continue;
    }

    if (tag === "else") {
      const frame = stack.at(-1);
      if (!frame) throw new TemplateError("{{else}} outside a block", position);
      if (frame.inElse) throw new TemplateError("Duplicate {{else}}", position);
      frame.inElse = true;
      current = frame.node.otherwise;
      continue;
    }

    if (tag.startsWith("/")) {
      const name = tag.slice(1).trim();
      if (name !== "if" && name !== "each") {
        throw new TemplateError(`Unknown closing block "${name}"`, position);
      }
      const frame = stack.at(-1);
      if (!frame) {
        throw new TemplateError(`Closing {{/${name}}} without an open block`, position);
      }
      if (frame.node.type !== name) {
        throw new TemplateError(
          `Mismatched closing block: expected {{/${frame.node.type}}}, got {{/${name}}}`,
          position,
        );
      }
      stack.pop();
      current = frame.parent;
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
    throw new TemplateError(`Unclosed {{#${unclosed.node.type}}} block`, unclosed.node.position);
  }

  return root;
}

function property(value: unknown, parts: string[]): { found: boolean; value: unknown } {
  let current = value;
  for (const part of parts) {
    if ((typeof current !== "object" || current === null) && typeof current !== "function") {
      return { found: false, value: undefined };
    }
    if (!Object.prototype.hasOwnProperty.call(current, part)) {
      return { found: false, value: undefined };
    }
    current = (current as Record<string, unknown>)[part];
  }
  return { found: true, value: current };
}

function resolve(path: string, root: unknown, contexts: Context[]): unknown {
  if (path === "this") return contexts.at(-1)?.value;
  if (path === "@index") return contexts.at(-1)?.index;

  if (path.startsWith("this.")) {
    return property(contexts.at(-1)?.value, path.slice(5).split(".")).value;
  }

  const parts = path.split(".");
  const local = contexts.length ? property(contexts.at(-1)!.value, parts) : undefined;
  if (local?.found) return local.value;
  return property(root, parts).value;
}

function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return value !== "" && value !== 0 && value !== false && value != null;
}

function scalar(value: unknown, position: Position): string {
  if (value == null) return "";
  switch (typeof value) {
    case "string":
    case "number":
    case "bigint":
    case "boolean":
    case "symbol":
      return String(value);
    default:
      throw new TemplateError(
        `Cannot render ${typeof value === "function" ? "function" : "object"} value as text`,
        position,
      );
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
    if (node.type === "text") {
      output += node.value;
    } else if (node.type === "value") {
      const text = scalar(resolve(node.path, root, contexts), node.position);
      output += node.escaped ? escapeHtml(text) : text;
    } else if (node.type === "if") {
      const branch = truthy(resolve(node.path, root, contexts)) ? node.then : node.otherwise;
      output += renderNodes(branch, root, contexts);
    } else {
      const value = resolve(node.path, root, contexts);
      if (Array.isArray(value) && value.length > 0) {
        for (let index = 0; index < value.length; index++) {
          contexts.push({ value: value[index], index });
          output += renderNodes(node.body, root, contexts);
          contexts.pop();
        }
      } else {
        output += renderNodes(node.otherwise, root, contexts);
      }
    }
  }
  return output;
}

/** Render a Mini Template string with the supplied data. */
export function render(template: string, data: unknown): string {
  return renderNodes(parse(template), data, []);
}
