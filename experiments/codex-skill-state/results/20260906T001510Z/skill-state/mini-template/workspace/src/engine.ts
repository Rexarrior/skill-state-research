type Position = {
  line: number;
  column: number;
};

type Node =
  | { type: "text"; value: string }
  | { type: "value"; path: string; escaped: boolean; position: Position }
  | {
      type: "block";
      kind: "if" | "each";
      path: string;
      body: Node[];
      otherwise: Node[];
      position: Position;
    };

type BlockNode = Extract<Node, { type: "block" }>;

type Frame = {
  block?: BlockNode;
  children: Node[];
  inElse: boolean;
};

type Context = {
  root: unknown;
  current: unknown;
  index?: number;
};

const MISSING = Symbol("missing");

function positionAt(source: string, offset: number): Position {
  let line = 1;
  let column = 1;

  for (let i = 0; i < offset; i++) {
    if (source[i] === "\n") {
      line++;
      column = 1;
    } else {
      column++;
    }
  }

  return { line, column };
}

function fail(message: string, position: Position): never {
  throw new Error(`${message} at line ${position.line}, column ${position.column}`);
}

function parse(template: string): Node[] {
  const root: Node[] = [];
  const stack: Frame[] = [{ children: root, inElse: false }];
  let cursor = 0;

  const append = (node: Node) => stack[stack.length - 1]!.children.push(node);

  while (cursor < template.length) {
    const opening = template.indexOf("{{", cursor);
    if (opening === -1) {
      append({ type: "text", value: template.slice(cursor) });
      break;
    }

    if (opening > cursor) {
      append({ type: "text", value: template.slice(cursor, opening) });
    }

    const position = positionAt(template, opening);
    const triple = template.startsWith("{{{", opening);
    const closingToken = triple ? "}}}" : "}}";
    const contentStart = opening + (triple ? 3 : 2);
    const closing = template.indexOf(closingToken, contentStart);

    if (closing === -1) {
      fail(`Unclosed ${triple ? "triple interpolation" : "tag"}`, position);
    }

    const content = template.slice(contentStart, closing).trim();
    cursor = closing + closingToken.length;

    if (triple) {
      if (!content) fail("Empty interpolation", position);
      append({ type: "value", path: content, escaped: false, position });
      continue;
    }

    if (content.startsWith("!")) continue;

    if (content === "else") {
      if (stack.length === 1) fail("'else' outside a block", position);
      const frame = stack[stack.length - 1]!;
      if (frame.inElse) fail("Duplicate 'else'", position);
      frame.inElse = true;
      frame.children = frame.block!.otherwise;
      continue;
    }

    if (content.startsWith("#")) {
      const match = /^#(if|each)(?:\s+(.+?))?$/.exec(content);
      if (!match) {
        const name = content.slice(1).split(/\s/, 1)[0] || "(empty)";
        fail(`Unknown block '${name}'`, position);
      }
      const kind = match[1] as "if" | "each";
      const path = match[2]?.trim();
      if (!path) fail(`Block '${kind}' requires a path`, position);
      const block: BlockNode = {
        type: "block",
        kind,
        path,
        body: [],
        otherwise: [],
        position,
      };
      append(block);
      stack.push({ block, children: block.body, inElse: false });
      continue;
    }

    if (content.startsWith("/")) {
      const name = content.slice(1).trim();
      if (!name || /\s/.test(name)) fail(`Invalid closing tag '${content}'`, position);
      if (stack.length === 1) fail(`Unexpected closing block '${name}'`, position);
      const frame = stack[stack.length - 1]!;
      if (name !== frame.block!.kind) {
        fail(`Mismatched closing block '${name}'; expected '${frame.block!.kind}'`, position);
      }
      stack.pop();
      continue;
    }

    if (!content) fail("Empty interpolation", position);
    append({ type: "value", path: content, escaped: true, position });
  }

  if (stack.length > 1) {
    const block = stack[stack.length - 1]!.block!;
    fail(`Unclosed block '${block.kind}'`, block.position);
  }

  return root;
}

function property(value: unknown, segments: string[]): unknown | typeof MISSING {
  let current = value;
  for (const segment of segments) {
    if ((typeof current !== "object" || current === null) && typeof current !== "function") {
      return MISSING;
    }
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return MISSING;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function resolve(path: string, context: Context): unknown | typeof MISSING {
  if (path === "this") return context.current;
  if (path === "@index") return context.index === undefined ? MISSING : context.index;

  if (path.startsWith("this.")) {
    return property(context.current, path.slice(5).split("."));
  }

  const segments = path.split(".");
  if (segments.some((segment) => segment.length === 0)) return MISSING;
  const local = property(context.current, segments);
  return local === MISSING ? property(context.root, segments) : local;
}

function isTruthy(value: unknown | typeof MISSING): boolean {
  if (value === MISSING || value === null || value === undefined || value === false) return false;
  if (value === "" || value === 0) return false;
  if (Array.isArray(value) && value.length === 0) return false;
  return true;
}

function scalar(value: unknown | typeof MISSING, path: string, position: Position): string {
  if (value === MISSING || value === null || value === undefined) return "";
  switch (typeof value) {
    case "string":
      return value;
    case "number":
    case "boolean":
    case "bigint":
      return String(value);
    default:
      fail(`Value '${path}' is not scalar and cannot be rendered`, position);
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

function renderNodes(nodes: Node[], context: Context): string {
  let output = "";
  for (const node of nodes) {
    if (node.type === "text") {
      output += node.value;
      continue;
    }

    if (node.type === "value") {
      const text = scalar(resolve(node.path, context), node.path, node.position);
      output += node.escaped ? escapeHtml(text) : text;
      continue;
    }

    const value = resolve(node.path, context);
    if (node.kind === "if") {
      output += renderNodes(isTruthy(value) ? node.body : node.otherwise, context);
    } else if (Array.isArray(value) && value.length > 0) {
      for (let index = 0; index < value.length; index++) {
        output += renderNodes(node.body, { ...context, current: value[index], index });
      }
    } else {
      output += renderNodes(node.otherwise, context);
    }
  }
  return output;
}

/** Render a Mini Template string with the supplied data. */
export function render(template: string, data: unknown): string {
  if (typeof template !== "string") throw new TypeError("Template must be a string");
  return renderNodes(parse(template), { root: data, current: data });
}
