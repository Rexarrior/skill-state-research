type Location = { line: number; column: number };

type Node =
  | { kind: "text"; value: string }
  | { kind: "value"; path: string; escaped: boolean; location: Location }
  | { kind: "if"; path: string; truthy: Node[]; falsy: Node[]; location: Location }
  | { kind: "each"; path: string; items: Node[]; empty: Node[]; location: Location };

type BlockNode = Extract<Node, { kind: "if" | "each" }>;
type Frame = { node: BlockNode; parent: Node[]; inElse: boolean };
type LoopContext = { value: unknown; index: number };

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

function parse(source: string): Node[] {
  const root: Node[] = [];
  const stack: Frame[] = [];
  let output = root;
  let cursor = 0;

  while (cursor < source.length) {
    const start = source.indexOf("{{", cursor);
    if (start < 0) {
      output.push({ kind: "text", value: source.slice(cursor) });
      break;
    }
    if (start > cursor) output.push({ kind: "text", value: source.slice(cursor, start) });

    const triple = source.startsWith("{{{", start);
    const closing = triple ? "}}}" : "}}";
    const contentStart = start + (triple ? 3 : 2);
    const end = source.indexOf(closing, contentStart);
    const location = locationAt(source, start);
    if (end < 0) throw syntaxError("Unclosed template tag", location);

    const tag = source.slice(contentStart, end).trim();
    cursor = end + closing.length;

    if (triple) {
      if (!tag) throw syntaxError("Interpolation path cannot be empty", location);
      output.push({ kind: "value", path: tag, escaped: false, location });
      continue;
    }
    if (tag.startsWith("!")) continue;

    if (tag === "else") {
      const frame = stack.at(-1);
      if (!frame) throw syntaxError("'else' appears outside a block", location);
      if (frame.inElse) throw syntaxError("Duplicate 'else'", location);
      frame.inElse = true;
      output = frame.node.kind === "if" ? frame.node.falsy : frame.node.empty;
      continue;
    }

    if (tag.startsWith("#")) {
      const match = /^#(if|each)\s+(.+)$/.exec(tag);
      if (!match) {
        const name = tag.slice(1).trim().split(/\s+/, 1)[0] || "(empty)";
        throw syntaxError(`Unknown or malformed block '${name}'`, location);
      }
      const [, blockKind, path] = match;
      const node: BlockNode = blockKind === "if"
        ? { kind: "if", path: path.trim(), truthy: [], falsy: [], location }
        : { kind: "each", path: path.trim(), items: [], empty: [], location };
      output.push(node);
      stack.push({ node, parent: output, inElse: false });
      output = node.kind === "if" ? node.truthy : node.items;
      continue;
    }

    if (tag.startsWith("/")) {
      const name = tag.slice(1).trim();
      const frame = stack.at(-1);
      if (!frame) throw syntaxError(`Unexpected closing block '${name}'`, location);
      if (name !== frame.node.kind) {
        throw syntaxError(`Mismatched closing block '${name}'; expected '${frame.node.kind}'`, location);
      }
      stack.pop();
      output = frame.parent;
      continue;
    }

    if (!tag) throw syntaxError("Interpolation path cannot be empty", location);
    output.push({ kind: "value", path: tag, escaped: true, location });
  }

  const unclosed = stack.at(-1);
  if (unclosed) throw syntaxError(`Unclosed '${unclosed.node.kind}' block`, unclosed.node.location);
  return root;
}

function lookup(value: unknown, parts: string[]): { found: boolean; value: unknown } {
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

function resolve(path: string, root: unknown, loops: LoopContext[]): unknown {
  const current = loops.at(-1);
  if (path === "this") return current?.value;
  if (path === "@index") return current?.index;
  if (path.startsWith("this.")) {
    return current ? lookup(current.value, path.slice(5).split(".")).value : undefined;
  }

  const parts = path.split(".");
  if (current) {
    const local = lookup(current.value, parts);
    if (local.found) return local.value;
  }
  return lookup(root, parts).value;
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
    case "bigint":
    case "boolean":
      return String(value);
    default:
      throw syntaxError(`Value at '${path}' is not scalar and cannot be rendered`, location);
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[character]!);
}

function renderNodes(nodes: Node[], root: unknown, loops: LoopContext[]): string {
  let result = "";
  for (const node of nodes) {
    if (node.kind === "text") {
      result += node.value;
    } else if (node.kind === "value") {
      const text = scalar(resolve(node.path, root, loops), node.path, node.location);
      result += node.escaped ? escapeHtml(text) : text;
    } else if (node.kind === "if") {
      const branch = isTruthy(resolve(node.path, root, loops)) ? node.truthy : node.falsy;
      result += renderNodes(branch, root, loops);
    } else {
      const value = resolve(node.path, root, loops);
      if (Array.isArray(value) && value.length > 0) {
        for (let index = 0; index < value.length; index++) {
          result += renderNodes(node.items, root, [...loops, { value: value[index], index }]);
        }
      } else {
        result += renderNodes(node.empty, root, loops);
      }
    }
  }
  return result;
}

/** Render a Mini Template string using the supplied data. */
export function render(template: string, data: unknown): string {
  return renderNodes(parse(template), data, []);
}
