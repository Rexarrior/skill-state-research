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
  truthy: Node[];
  falsy: Node[];
  position: Position;
};
type Node = TextNode | ValueNode | BlockNode;

type Frame = {
  block: BlockNode;
  body: Node[];
  hasElse: boolean;
};

type LoopContext = {
  item: unknown;
  index: number;
};

/** An error in template structure or value rendering. */
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
  for (let index = 0; index < offset; index++) {
    if (source[index] === "\n") {
      line++;
      column = 1;
    } else {
      column++;
    }
  }
  return { offset, line, column };
}

function validatePath(path: string, position: Position): string {
  if (!path) {
    throw new TemplateError("Expected a path", position);
  }
  if (/\s/.test(path)) {
    throw new TemplateError(`Invalid path \"${path}\"`, position);
  }
  return path;
}

function parse(template: string): Node[] {
  const root: Node[] = [];
  const stack: Frame[] = [];
  let body = root;
  let cursor = 0;

  while (cursor < template.length) {
    const open = template.indexOf("{{", cursor);
    if (open === -1) {
      body.push({ type: "text", value: template.slice(cursor) });
      break;
    }
    if (open > cursor) {
      body.push({ type: "text", value: template.slice(cursor, open) });
    }

    const triple = template.startsWith("{{{", open);
    const closeToken = triple ? "}}}" : "}}";
    const contentStart = open + (triple ? 3 : 2);
    const close = template.indexOf(closeToken, contentStart);
    const position = positionAt(template, open);
    if (close === -1) {
      throw new TemplateError(`Unclosed ${triple ? "triple" : "tag"}`, position);
    }

    const raw = template.slice(contentStart, close).trim();
    cursor = close + closeToken.length;

    if (triple) {
      body.push({ type: "value", path: validatePath(raw, position), escaped: false, position });
      continue;
    }
    if (raw.startsWith("!")) {
      continue;
    }
    if (raw === "else") {
      const frame = stack.at(-1);
      if (!frame) {
        throw new TemplateError("else outside a block", position);
      }
      if (frame.hasElse) {
        throw new TemplateError("Duplicate else", position);
      }
      frame.hasElse = true;
      frame.body = frame.block.falsy;
      body = frame.body;
      continue;
    }
    if (raw.startsWith("#")) {
      const match = /^#(if|each)(?:\s+(.+))?$/.exec(raw);
      if (!match) {
        const name = raw.slice(1).split(/\s/, 1)[0] || raw;
        throw new TemplateError(`Unknown block \"${name}\"`, position);
      }
      const block: BlockNode = {
        type: match[1] as "if" | "each",
        path: validatePath((match[2] ?? "").trim(), position),
        truthy: [],
        falsy: [],
        position,
      };
      body.push(block);
      const frame: Frame = { block, body: block.truthy, hasElse: false };
      stack.push(frame);
      body = frame.body;
      continue;
    }
    if (raw.startsWith("/")) {
      const name = raw.slice(1).trim();
      if (name !== "if" && name !== "each") {
        throw new TemplateError(`Unknown closing block \"${name}\"`, position);
      }
      const frame = stack.at(-1);
      if (!frame) {
        throw new TemplateError(`Closing ${name} without an open block`, position);
      }
      if (frame.block.type !== name) {
        throw new TemplateError(`Mismatched closing block: expected /${frame.block.type}, got /${name}`, position);
      }
      stack.pop();
      body = stack.at(-1)?.body ?? root;
      continue;
    }

    body.push({ type: "value", path: validatePath(raw, position), escaped: true, position });
  }

  const unclosed = stack.at(-1)?.block;
  if (unclosed) {
    throw new TemplateError(`Unclosed ${unclosed.type} block`, unclosed.position);
  }
  return root;
}

function lookup(base: unknown, segments: string[]): unknown {
  let value = base;
  for (const segment of segments) {
    if ((typeof value !== "object" && typeof value !== "function") || value === null) {
      return undefined;
    }
    if (!Object.prototype.hasOwnProperty.call(value, segment)) {
      return undefined;
    }
    value = (value as Record<string, unknown>)[segment];
  }
  return value;
}

function resolve(path: string, root: unknown, loops: LoopContext[]): unknown {
  const current = loops.at(-1);
  if (path === "@index") {
    return current?.index;
  }
  if (path === "this") {
    return current ? current.item : root;
  }
  if (path.startsWith("this.")) {
    return lookup(current ? current.item : root, path.slice(5).split("."));
  }
  return lookup(root, path.split("."));
}

function isTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === 0 || value === "") {
    return false;
  }
  return !Array.isArray(value) || value.length > 0;
}

function scalar(value: unknown, path: string, position: Position): string {
  if (value === null || value === undefined) {
    return "";
  }
  switch (typeof value) {
    case "string":
      return value;
    case "number":
    case "boolean":
    case "bigint":
      return String(value);
    default:
      throw new TemplateError(`Value at \"${path}\" is not scalar`, position);
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

function renderNodes(nodes: Node[], root: unknown, loops: LoopContext[]): string {
  let output = "";
  for (const node of nodes) {
    if (node.type === "text") {
      output += node.value;
    } else if (node.type === "value") {
      const text = scalar(resolve(node.path, root, loops), node.path, node.position);
      output += node.escaped ? escapeHtml(text) : text;
    } else if (node.type === "if") {
      const value = resolve(node.path, root, loops);
      output += renderNodes(isTruthy(value) ? node.truthy : node.falsy, root, loops);
    } else {
      const value = resolve(node.path, root, loops);
      if (Array.isArray(value) && value.length > 0) {
        for (let index = 0; index < value.length; index++) {
          output += renderNodes(node.truthy, root, [...loops, { item: value[index], index }]);
        }
      } else {
        output += renderNodes(node.falsy, root, loops);
      }
    }
  }
  return output;
}

/** Parse and render a mini-template using the supplied root data. */
export function render(template: string, data: unknown): string {
  return renderNodes(parse(template), data, []);
}
