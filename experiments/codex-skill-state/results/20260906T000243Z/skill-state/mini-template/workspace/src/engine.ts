type Position = {
  offset: number;
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

type OpenBlock = {
  node: BlockNode;
  parent: Node[];
  inElse: boolean;
};

type LoopFrame = { value: unknown; index: number };
type RenderContext = { root: unknown; loops: LoopFrame[] };

class TemplateError extends Error {
  constructor(message: string, position: Position) {
    super(`${message} at line ${position.line}, column ${position.column}`);
    this.name = "TemplateError";
  }
}

function positionAt(source: string, offset: number): Position {
  let line = 1;
  let column = 1;

  for (let index = 0; index < offset; index += 1) {
    if (source.charCodeAt(index) === 10) {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }

  return { offset, line, column };
}

function requirePath(path: string, position: Position, tag: string): string {
  if (path.length === 0) {
    throw new TemplateError(`Missing path in ${tag} tag`, position);
  }
  return path;
}

function parse(template: string): Node[] {
  const root: Node[] = [];
  const stack: OpenBlock[] = [];
  let target = root;
  let cursor = 0;

  while (cursor < template.length) {
    const start = template.indexOf("{{", cursor);
    if (start === -1) {
      target.push({ type: "text", value: template.slice(cursor) });
      break;
    }

    if (start > cursor) {
      target.push({ type: "text", value: template.slice(cursor, start) });
    }

    const triple = template.startsWith("{{{", start);
    const close = triple ? "}}}" : "}}";
    const contentStart = start + (triple ? 3 : 2);
    const end = template.indexOf(close, contentStart);
    const position = positionAt(template, start);

    if (end === -1) {
      throw new TemplateError("Unclosed tag", position);
    }

    const content = template.slice(contentStart, end).trim();
    cursor = end + close.length;

    if (triple) {
      target.push({
        type: "value",
        path: requirePath(content, position, "interpolation"),
        escaped: false,
        position,
      });
      continue;
    }

    if (content.startsWith("!")) {
      continue;
    }

    if (content === "else") {
      const open = stack.at(-1);
      if (!open) {
        throw new TemplateError("else outside a block", position);
      }
      if (open.inElse) {
        throw new TemplateError("Duplicate else", position);
      }
      open.inElse = true;
      target = open.node.alternate;
      continue;
    }

    if (content.startsWith("#")) {
      const match = /^#(\S+)(?:\s+(.+))?$/.exec(content);
      const kind = match?.[1];
      if (kind !== "if" && kind !== "each") {
        throw new TemplateError(`Unknown block ${kind ? `"${kind}"` : "tag"}`, position);
      }
      const path = requirePath(match?.[2]?.trim() ?? "", position, `#${kind}`);
      const node: BlockNode = {
        type: kind,
        path,
        consequent: [],
        alternate: [],
        position,
      };
      target.push(node);
      stack.push({ node, parent: target, inElse: false });
      target = node.consequent;
      continue;
    }

    if (content.startsWith("/")) {
      const kind = content.slice(1).trim();
      const open = stack.at(-1);
      if (!open) {
        throw new TemplateError(`Closing ${kind || "block"} without an open block`, position);
      }
      if (kind !== open.node.type) {
        throw new TemplateError(
          `Mismatched closing block: expected /${open.node.type}, got /${kind || "?"}`,
          position,
        );
      }
      stack.pop();
      target = open.parent;
      continue;
    }

    target.push({
      type: "value",
      path: requirePath(content, position, "interpolation"),
      escaped: true,
      position,
    });
  }

  const unclosed = stack.at(-1);
  if (unclosed) {
    throw new TemplateError(`Unclosed #${unclosed.node.type} block`, unclosed.node.position);
  }

  return root;
}

const MISSING = Symbol("missing");

function lookup(value: unknown, parts: string[]): unknown | typeof MISSING {
  let current = value;

  for (const part of parts) {
    if ((typeof current !== "object" || current === null) && typeof current !== "function") {
      return MISSING;
    }
    if (!Object.prototype.hasOwnProperty.call(current, part)) {
      return MISSING;
    }
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

function resolve(path: string, context: RenderContext): unknown | typeof MISSING {
  const loop = context.loops.at(-1);

  if (path === "this") return loop ? loop.value : context.root;
  if (path.startsWith("this.")) {
    return lookup(loop ? loop.value : context.root, path.slice(5).split("."));
  }
  if (path === "@index") return loop ? loop.index : MISSING;

  const parts = path.split(".");
  if (parts.some((part) => part.length === 0)) return MISSING;

  if (loop) {
    const local = lookup(loop.value, parts);
    if (local !== MISSING) return local;
  }
  return lookup(context.root, parts);
}

function isTruthy(value: unknown | typeof MISSING): boolean {
  if (value === MISSING || value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.length > 0;
  return value !== "" && value !== 0 && value !== false;
}

function scalarText(value: unknown | typeof MISSING, node: ValueNode): string {
  if (value === MISSING || value === null || value === undefined) return "";
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }
  throw new TemplateError(
    `Cannot render non-scalar value at path "${node.path}"`,
    node.position,
  );
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

function renderNodes(nodes: Node[], context: RenderContext): string {
  let output = "";

  for (const node of nodes) {
    if (node.type === "text") {
      output += node.value;
      continue;
    }

    const value = resolve(node.path, context);
    if (node.type === "value") {
      const text = scalarText(value, node);
      output += node.escaped ? escapeHtml(text) : text;
      continue;
    }

    if (node.type === "if") {
      output += renderNodes(isTruthy(value) ? node.consequent : node.alternate, context);
      continue;
    }

    if (Array.isArray(value) && value.length > 0) {
      for (let index = 0; index < value.length; index += 1) {
        output += renderNodes(node.consequent, {
          root: context.root,
          loops: [...context.loops, { value: value[index], index }],
        });
      }
    } else {
      output += renderNodes(node.alternate, context);
    }
  }

  return output;
}

export function render(template: string, data: unknown): string {
  return renderNodes(parse(template), { root: data, loops: [] });
}
