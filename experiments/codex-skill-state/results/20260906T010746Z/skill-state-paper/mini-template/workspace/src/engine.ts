type Location = { line: number; column: number };

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
  body: Node[];
  alternate: Node[];
  location: Location;
};
type Node = TextNode | ValueNode | BlockNode;

type Frame = {
  node: BlockNode;
  parent: Node[];
  inAlternate: boolean;
};

type Context = {
  root: unknown;
  current: unknown;
  index: number | undefined;
};

class TemplateError extends Error {
  constructor(message: string, location: Location) {
    super(`${message} at line ${location.line}, column ${location.column}`);
    this.name = "TemplateError";
  }
}

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

function parse(template: string): Node[] {
  const root: Node[] = [];
  const stack: Frame[] = [];
  let target = root;
  let cursor = 0;

  while (cursor < template.length) {
    const open = template.indexOf("{{", cursor);
    if (open === -1) {
      target.push({ type: "text", value: template.slice(cursor) });
      break;
    }
    if (open > cursor) {
      target.push({ type: "text", value: template.slice(cursor, open) });
    }

    const triple = template.startsWith("{{{", open);
    const closing = triple ? "}}}" : "}}";
    const contentStart = open + (triple ? 3 : 2);
    const close = template.indexOf(closing, contentStart);
    const location = locationAt(template, open);
    if (close === -1) {
      throw new TemplateError("Unclosed tag", location);
    }

    const content = template.slice(contentStart, close).trim();
    cursor = close + closing.length;

    if (triple) {
      if (!content) throw new TemplateError("Empty interpolation", location);
      target.push({ type: "value", path: content, escaped: false, location });
      continue;
    }

    if (content.startsWith("!")) continue;

    if (content.startsWith("#")) {
      const match = /^#(if|each)\s+(.+)$/.exec(content);
      if (!match) {
        const name = content.slice(1).trim().split(/\s+/, 1)[0] || "(empty)";
        throw new TemplateError(`Unknown or malformed block '${name}'`, location);
      }
      const block: BlockNode = {
        type: match[1] as "if" | "each",
        path: match[2].trim(),
        body: [],
        alternate: [],
        location,
      };
      target.push(block);
      stack.push({ node: block, parent: target, inAlternate: false });
      target = block.body;
      continue;
    }

    if (content === "else") {
      const frame = stack.at(-1);
      if (!frame) throw new TemplateError("'else' outside a block", location);
      if (frame.inAlternate) throw new TemplateError("Duplicate 'else'", location);
      frame.inAlternate = true;
      target = frame.node.alternate;
      continue;
    }

    if (content.startsWith("/")) {
      const name = content.slice(1).trim();
      const frame = stack.at(-1);
      if (!frame) throw new TemplateError(`Closing '${name}' without an open block`, location);
      if (name !== frame.node.type) {
        throw new TemplateError(
          `Mismatched closing block '${name}'; expected '${frame.node.type}'`,
          location,
        );
      }
      stack.pop();
      target = frame.parent;
      continue;
    }

    if (!content) throw new TemplateError("Empty interpolation", location);
    target.push({ type: "value", path: content, escaped: true, location });
  }

  const unclosed = stack.at(-1);
  if (unclosed) {
    throw new TemplateError(`Unclosed '${unclosed.node.type}' block`, unclosed.node.location);
  }
  return root;
}

function property(value: unknown, parts: string[]): unknown {
  let result = value;
  for (const part of parts) {
    if ((typeof result !== "object" || result === null) && typeof result !== "function") {
      return undefined;
    }
    if (!Object.prototype.hasOwnProperty.call(result, part)) return undefined;
    result = (result as Record<string, unknown>)[part];
  }
  return result;
}

function resolve(path: string, context: Context): unknown {
  if (path === "this") return context.current;
  if (path === "@index") return context.index;
  if (path.startsWith("this.")) return property(context.current, path.slice(5).split("."));
  if (path.startsWith("@index.")) return undefined;

  const parts = path.split(".");
  const local = property(context.current, parts);
  return local === undefined ? property(context.root, parts) : local;
}

function isTruthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return value !== "" && value !== 0 && value !== false && value !== null && value !== undefined;
}

function scalar(value: unknown, path: string, location: Location): string {
  if (value === null || value === undefined) return "";
  switch (typeof value) {
    case "string":
    case "number":
    case "boolean":
    case "bigint":
      return String(value);
    default:
      throw new TemplateError(`Value '${path}' cannot be rendered as scalar text`, location);
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
      const text = scalar(resolve(node.path, context), node.path, node.location);
      output += node.escaped ? escapeHtml(text) : text;
    } else if (node.type === "if") {
      const branch = isTruthy(resolve(node.path, context)) ? node.body : node.alternate;
      output += renderNodes(branch, context);
    } else {
      const value = resolve(node.path, context);
      if (!Array.isArray(value) || value.length === 0) {
        output += renderNodes(node.alternate, context);
      } else {
        for (let index = 0; index < value.length; index++) {
          output += renderNodes(node.body, { ...context, current: value[index], index });
        }
      }
    }
  }
  return output;
}

export function render(template: string, data: unknown): string {
  return renderNodes(parse(template), { root: data, current: data, index: undefined });
}
