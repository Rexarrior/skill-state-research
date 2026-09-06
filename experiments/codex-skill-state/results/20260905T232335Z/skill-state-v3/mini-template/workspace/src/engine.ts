type Position = {
  line: number;
  column: number;
};

type TextNode = {
  kind: "text";
  value: string;
};

type ValueNode = {
  kind: "value";
  path: string;
  escaped: boolean;
  position: Position;
};

type BlockNode = {
  kind: "if" | "each";
  path: string;
  body: Node[];
  alternate: Node[];
  position: Position;
};

type Node = TextNode | ValueNode | BlockNode;

type Frame = {
  block: BlockNode;
  parent: Node[];
  inAlternate: boolean;
};

type RenderContext = {
  root: unknown;
  current: unknown;
  index?: number;
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

  for (let i = 0; i < offset; i += 1) {
    if (source.charCodeAt(i) === 10) {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }

  return { line, column };
}

function requirePath(path: string, tag: string, position: Position): string {
  const trimmed = path.trim();
  if (!trimmed) {
    throw new TemplateError(`${tag} requires a path`, position);
  }
  if (/\s/.test(trimmed)) {
    throw new TemplateError(`Invalid path in ${tag}`, position);
  }
  return trimmed;
}

function parse(template: string): Node[] {
  const root: Node[] = [];
  const stack: Frame[] = [];
  let target = root;
  let cursor = 0;

  while (cursor < template.length) {
    const start = template.indexOf("{{", cursor);
    if (start === -1) {
      target.push({ kind: "text", value: template.slice(cursor) });
      break;
    }

    if (start > cursor) {
      target.push({ kind: "text", value: template.slice(cursor, start) });
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
        kind: "value",
        path: requirePath(content, "Interpolation", position),
        escaped: false,
        position,
      });
      continue;
    }

    if (content.startsWith("!")) {
      continue;
    }

    if (content === "else") {
      const frame = stack[stack.length - 1];
      if (!frame) {
        throw new TemplateError("else outside a block", position);
      }
      if (frame.inAlternate) {
        throw new TemplateError("Duplicate else", position);
      }
      frame.inAlternate = true;
      target = frame.block.alternate;
      continue;
    }

    if (content.startsWith("#")) {
      const match = /^#([^\s]+)(?:\s+(.*))?$/.exec(content);
      const name = match?.[1] ?? content.slice(1);
      if (name !== "if" && name !== "each") {
        throw new TemplateError(`Unknown block '${name}'`, position);
      }
      const block: BlockNode = {
        kind: name,
        path: requirePath(match?.[2] ?? "", `#${name}`, position),
        body: [],
        alternate: [],
        position,
      };
      target.push(block);
      stack.push({ block, parent: target, inAlternate: false });
      target = block.body;
      continue;
    }

    if (content.startsWith("/")) {
      const name = content.slice(1).trim();
      const frame = stack[stack.length - 1];
      if (!frame) {
        throw new TemplateError(`Closing '${name}' without an open block`, position);
      }
      if (name !== frame.block.kind) {
        throw new TemplateError(
          `Mismatched closing block: expected '/${frame.block.kind}', got '/${name}'`,
          position,
        );
      }
      stack.pop();
      target = frame.parent;
      continue;
    }

    target.push({
      kind: "value",
      path: requirePath(content, "Interpolation", position),
      escaped: true,
      position,
    });
  }

  const frame = stack[stack.length - 1];
  if (frame) {
    throw new TemplateError(`Unclosed '${frame.block.kind}' block`, frame.block.position);
  }

  return root;
}

function lookup(value: unknown, parts: string[]): unknown {
  let current = value;
  for (const part of parts) {
    if ((typeof current !== "object" || current === null) && typeof current !== "function") {
      return undefined;
    }
    if (!Object.prototype.hasOwnProperty.call(current, part)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function resolve(path: string, context: RenderContext): unknown {
  if (path === "this") return context.current;
  if (path === "@index") return context.index;

  if (path.startsWith("this.")) {
    return lookup(context.current, path.slice(5).split("."));
  }

  const parts = path.split(".");
  const local = lookup(context.current, parts);
  return local === undefined && context.current !== context.root
    ? lookup(context.root, parts)
    : local;
}

function truthy(value: unknown): boolean {
  if (value === "" || value === 0 || value === false || value == null) return false;
  return !Array.isArray(value) || value.length > 0;
}

function scalar(value: unknown, path: string, position: Position): string {
  if (value == null) return "";
  switch (typeof value) {
    case "string":
    case "number":
    case "boolean":
    case "bigint":
      return String(value);
    default:
      throw new TemplateError(`Value '${path}' is not scalar and cannot be rendered`, position);
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

function renderNodes(nodes: Node[], context: RenderContext): string {
  let output = "";

  for (const node of nodes) {
    if (node.kind === "text") {
      output += node.value;
      continue;
    }

    const value = resolve(node.path, context);
    if (node.kind === "value") {
      const text = scalar(value, node.path, node.position);
      output += node.escaped ? escapeHtml(text) : text;
      continue;
    }

    if (node.kind === "if") {
      output += renderNodes(truthy(value) ? node.body : node.alternate, context);
      continue;
    }

    if (!Array.isArray(value) || value.length === 0) {
      output += renderNodes(node.alternate, context);
      continue;
    }

    for (let index = 0; index < value.length; index += 1) {
      output += renderNodes(node.body, {
        root: context.root,
        current: value[index],
        index,
      });
    }
  }

  return output;
}

export function render(template: string, data: unknown): string {
  return renderNodes(parse(template), { root: data, current: data });
}
