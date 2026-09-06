type Location = { line: number; column: number };

type TextNode = { kind: "text"; value: string };
type ValueNode = { kind: "value"; path: string; escaped: boolean; location: Location };
type BlockNode = {
  kind: "if" | "each";
  path: string;
  body: Node[];
  alternate: Node[];
  location: Location;
};
type Node = TextNode | ValueNode | BlockNode;

type Frame = {
  block: BlockNode;
  parent: Node[];
  inElse: boolean;
};

type Context = { current: unknown; index: number | undefined };

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

function requirePath(tag: string, prefix: string, location: Location): string {
  const path = tag.slice(prefix.length).trim();
  if (!path) throw syntaxError(`Missing path for ${prefix.trim()}`, location);
  return path;
}

function parse(template: string): Node[] {
  const root: Node[] = [];
  const stack: Frame[] = [];
  let output = root;
  let cursor = 0;

  while (cursor < template.length) {
    const start = template.indexOf("{{", cursor);
    if (start === -1) {
      output.push({ kind: "text", value: template.slice(cursor) });
      break;
    }
    if (start > cursor) output.push({ kind: "text", value: template.slice(cursor, start) });

    const triple = template.startsWith("{{{", start);
    const close = triple ? "}}}" : "}}";
    const contentStart = start + (triple ? 3 : 2);
    const end = template.indexOf(close, contentStart);
    const location = locationAt(template, start);
    if (end === -1) throw syntaxError("Unclosed tag", location);

    const tag = template.slice(contentStart, end).trim();
    cursor = end + close.length;
    if (!tag) throw syntaxError("Empty tag", location);

    if (triple) {
      output.push({ kind: "value", path: tag, escaped: false, location });
      continue;
    }
    if (tag.startsWith("!")) continue;

    if (tag.startsWith("#")) {
      let kind: "if" | "each";
      let path: string;
      if (tag === "#if" || tag.startsWith("#if ")) {
        kind = "if";
        path = requirePath(tag, "#if", location);
      } else if (tag === "#each" || tag.startsWith("#each ")) {
        kind = "each";
        path = requirePath(tag, "#each", location);
      } else {
        throw syntaxError(`Unknown block '${tag}'`, location);
      }
      const block: BlockNode = { kind, path, body: [], alternate: [], location };
      output.push(block);
      stack.push({ block, parent: output, inElse: false });
      output = block.body;
      continue;
    }

    if (tag === "else") {
      const frame = stack.at(-1);
      if (!frame) throw syntaxError("else outside a block", location);
      if (frame.inElse) throw syntaxError("Duplicate else", location);
      frame.inElse = true;
      output = frame.block.alternate;
      continue;
    }

    if (tag.startsWith("/")) {
      const closeKind = tag.slice(1).trim();
      if (closeKind !== "if" && closeKind !== "each") {
        throw syntaxError(`Unknown closing block '${tag}'`, location);
      }
      const frame = stack.at(-1);
      if (!frame) throw syntaxError(`Closing ${closeKind} without an open block`, location);
      if (frame.block.kind !== closeKind) {
        throw syntaxError(`Mismatched close: expected /${frame.block.kind}, got /${closeKind}`, location);
      }
      stack.pop();
      output = frame.parent;
      continue;
    }

    output.push({ kind: "value", path: tag, escaped: true, location });
  }

  const unclosed = stack.at(-1);
  if (unclosed) throw syntaxError(`Unclosed ${unclosed.block.kind} block`, unclosed.block.location);
  return root;
}

function property(value: unknown, key: string): unknown {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return undefined;
  return Object.prototype.hasOwnProperty.call(value, key)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function follow(value: unknown, path: string[]): unknown {
  for (const part of path) value = property(value, part);
  return value;
}

function resolve(path: string, root: unknown, context: Context): unknown {
  if (path === "this") return context.current;
  if (path.startsWith("this.")) return follow(context.current, path.slice(5).split("."));
  if (path === "@index") return context.index;
  return follow(root, path.split("."));
}

function isTruthy(value: unknown): boolean {
  return !(
    value === "" || value === 0 || value === 0n || value === false ||
    value === null || value === undefined || (Array.isArray(value) && value.length === 0)
  );
}

function scalar(value: unknown, path: string, location: Location): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" ||
      typeof value === "bigint" || typeof value === "boolean") return String(value);
  throw syntaxError(`Value '${path}' cannot be rendered as scalar text`, location);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
  })[char]!);
}

function renderNodes(nodes: Node[], root: unknown, context: Context): string {
  let result = "";
  for (const node of nodes) {
    if (node.kind === "text") {
      result += node.value;
    } else if (node.kind === "value") {
      const value = scalar(resolve(node.path, root, context), node.path, node.location);
      result += node.escaped ? escapeHtml(value) : value;
    } else if (node.kind === "if") {
      const branch = isTruthy(resolve(node.path, root, context)) ? node.body : node.alternate;
      result += renderNodes(branch, root, context);
    } else {
      const value = resolve(node.path, root, context);
      if (Array.isArray(value) && value.length > 0) {
        for (let index = 0; index < value.length; index++) {
          result += renderNodes(node.body, root, { current: value[index], index });
        }
      } else {
        result += renderNodes(node.alternate, root, context);
      }
    }
  }
  return result;
}

/** Render a Mini Template string with the supplied root data. */
export function render(template: string, data: unknown): string {
  return renderNodes(parse(template), data, { current: data, index: undefined });
}
