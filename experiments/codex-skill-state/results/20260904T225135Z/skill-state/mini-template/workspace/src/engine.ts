type Position = {
  offset: number;
  line: number;
  column: number;
};

type TextNode = { kind: "text"; value: string };
type ValueNode = { kind: "value"; path: string; escaped: boolean; position: Position };
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

type Context = {
  root: unknown;
  current: unknown;
  index: number | undefined;
  inEach: boolean;
};

const MISSING = Symbol("missing");

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
  return { offset, line, column };
}

function syntaxError(message: string, position: Position): Error {
  return new Error(`${message} at line ${position.line}, column ${position.column}`);
}

function requirePath(command: string, prefix: string, position: Position): string {
  const path = command.slice(prefix.length).trim();
  if (!path) throw syntaxError(`${prefix.trim()} requires a path`, position);
  return path;
}

function parse(template: string): Node[] {
  const root: Node[] = [];
  const stack: Frame[] = [];
  let target = root;
  let cursor = 0;

  while (cursor < template.length) {
    const start = template.indexOf("{{", cursor);
    if (start < 0) {
      target.push({ kind: "text", value: template.slice(cursor) });
      break;
    }
    if (start > cursor) target.push({ kind: "text", value: template.slice(cursor, start) });

    const triple = template.startsWith("{{{", start);
    const close = triple ? "}}}" : "}}";
    const contentStart = start + (triple ? 3 : 2);
    const end = template.indexOf(close, contentStart);
    const position = positionAt(template, start);
    if (end < 0) throw syntaxError("Unclosed tag", position);

    const command = template.slice(contentStart, end).trim();
    cursor = end + close.length;

    if (triple) {
      if (!command) throw syntaxError("Interpolation requires a path", position);
      target.push({ kind: "value", path: command, escaped: false, position });
      continue;
    }

    if (command.startsWith("!")) continue;

    if (command.startsWith("#")) {
      let kind: "if" | "each";
      let path: string;
      if (command === "#if" || command.startsWith("#if ")) {
        kind = "if";
        path = requirePath(command, "#if", position);
      } else if (command === "#each" || command.startsWith("#each ")) {
        kind = "each";
        path = requirePath(command, "#each", position);
      } else {
        throw syntaxError(`Unknown block '${command}'`, position);
      }
      const block: BlockNode = { kind, path, body: [], alternate: [], position };
      target.push(block);
      stack.push({ block, parent: target, inAlternate: false });
      target = block.body;
      continue;
    }

    if (command === "else") {
      const frame = stack.at(-1);
      if (!frame) throw syntaxError("else outside a block", position);
      if (frame.inAlternate) throw syntaxError("Duplicate else", position);
      frame.inAlternate = true;
      target = frame.block.alternate;
      continue;
    }

    if (command.startsWith("/")) {
      const name = command.slice(1).trim();
      if (name !== "if" && name !== "each") {
        throw syntaxError(`Unknown closing block '${command}'`, position);
      }
      const frame = stack.at(-1);
      if (!frame) throw syntaxError(`Closing ${name} without an open block`, position);
      if (frame.block.kind !== name) {
        throw syntaxError(`Mismatched closing block: expected /${frame.block.kind}, got /${name}`, position);
      }
      stack.pop();
      target = frame.parent;
      continue;
    }

    if (!command) throw syntaxError("Interpolation requires a path", position);
    target.push({ kind: "value", path: command, escaped: true, position });
  }

  const unclosed = stack.at(-1)?.block;
  if (unclosed) throw syntaxError(`Unclosed ${unclosed.kind} block`, unclosed.position);
  return root;
}

function lookup(value: unknown, parts: string[]): unknown | typeof MISSING {
  let current = value;
  for (const part of parts) {
    if ((typeof current !== "object" || current === null) && typeof current !== "function") {
      return MISSING;
    }
    if (!(part in current)) return MISSING;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function resolve(path: string, context: Context): unknown | typeof MISSING {
  if (path === "this") return context.inEach ? context.current : context.root;
  if (path.startsWith("this.")) {
    const base = context.inEach ? context.current : context.root;
    return lookup(base, path.slice(5).split("."));
  }
  if (path === "@index") return context.inEach ? context.index : MISSING;
  if (path.startsWith("@")) return MISSING;

  const parts = path.split(".");
  if (parts.some((part) => part.length === 0)) return MISSING;
  if (context.inEach) {
    const local = lookup(context.current, parts);
    if (local !== MISSING) return local;
  }
  return lookup(context.root, parts);
}

function isTruthy(value: unknown | typeof MISSING): boolean {
  if (value === MISSING || value == null || value === false || value === 0 || value === "") return false;
  if (Array.isArray(value) && value.length === 0) return false;
  return true;
}

function scalar(value: unknown | typeof MISSING, path: string, position: Position): string {
  if (value === MISSING || value == null) return "";
  switch (typeof value) {
    case "string":
      return value;
    case "number":
    case "bigint":
    case "boolean":
      return String(value);
    default:
      throw syntaxError(`Value '${path}' cannot be rendered as scalar text`, position);
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
    if (node.kind === "text") {
      output += node.value;
    } else if (node.kind === "value") {
      const text = scalar(resolve(node.path, context), node.path, node.position);
      output += node.escaped ? escapeHtml(text) : text;
    } else if (node.kind === "if") {
      output += renderNodes(isTruthy(resolve(node.path, context)) ? node.body : node.alternate, context);
    } else {
      const value = resolve(node.path, context);
      if (Array.isArray(value) && value.length > 0) {
        for (let index = 0; index < value.length; index++) {
          output += renderNodes(node.body, {
            root: context.root,
            current: value[index],
            index,
            inEach: true,
          });
        }
      } else {
        output += renderNodes(node.alternate, context);
      }
    }
  }
  return output;
}

/** Render a Mini Template string with the supplied data. */
export function render(template: string, data: unknown): string {
  const nodes = parse(template);
  return renderNodes(nodes, { root: data, current: data, index: undefined, inEach: false });
}
