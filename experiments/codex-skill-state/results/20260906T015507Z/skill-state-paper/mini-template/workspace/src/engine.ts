type Location = { line: number; column: number };

type Node =
  | { kind: "text"; value: string }
  | { kind: "value"; path: string; escaped: boolean; location: Location }
  | { kind: "if"; path: string; truthy: Node[]; falsy: Node[]; location: Location }
  | { kind: "each"; path: string; body: Node[]; empty: Node[]; location: Location };

type BlockNode = Extract<Node, { kind: "if" | "each" }>;
type Frame = { node: BlockNode; parent: Node[]; hasElse: boolean };
type EachContext = { value: unknown; index: number };

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

function requirePath(path: string, construct: string, location: Location): string {
  if (!path) throw syntaxError(`${construct} requires a path`, location);
  return path;
}

function parse(template: string): Node[] {
  const root: Node[] = [];
  const stack: Frame[] = [];
  let current = root;
  let cursor = 0;

  while (cursor < template.length) {
    const start = template.indexOf("{{", cursor);
    if (start === -1) {
      current.push({ kind: "text", value: template.slice(cursor) });
      break;
    }
    if (start > cursor) current.push({ kind: "text", value: template.slice(cursor, start) });

    const location = locationAt(template, start);
    const triple = template.startsWith("{{{", start);
    const close = triple ? "}}}" : "}}";
    const contentStart = start + (triple ? 3 : 2);
    const end = template.indexOf(close, contentStart);
    if (end === -1) throw syntaxError(`Unclosed ${triple ? "triple " : ""}tag`, location);
    const tag = template.slice(contentStart, end).trim();
    cursor = end + close.length;

    if (triple) {
      current.push({ kind: "value", path: tag, escaped: false, location });
      continue;
    }
    if (tag.startsWith("!")) continue;

    if (tag.startsWith("#")) {
      const match = /^#(if|each)(?:\s+(.*))?$/.exec(tag);
      if (!match) throw syntaxError(`Unknown block '${tag}'`, location);
      const kind = match[1] as "if" | "each";
      const path = requirePath((match[2] ?? "").trim(), `#${kind}`, location);
      const node: BlockNode = kind === "if"
        ? { kind, path, truthy: [], falsy: [], location }
        : { kind, path, body: [], empty: [], location };
      current.push(node);
      stack.push({ node, parent: current, hasElse: false });
      current = node.kind === "if" ? node.truthy : node.body;
      continue;
    }

    if (tag === "else") {
      const frame = stack.at(-1);
      if (!frame) throw syntaxError("'else' outside a block", location);
      if (frame.hasElse) throw syntaxError("Duplicate 'else'", location);
      frame.hasElse = true;
      current = frame.node.kind === "if" ? frame.node.falsy : frame.node.empty;
      continue;
    }

    if (tag.startsWith("/")) {
      const closing = tag.slice(1).trim();
      const frame = stack.at(-1);
      if (!frame) throw syntaxError(`Unexpected closing block '/${closing}'`, location);
      if (closing !== frame.node.kind) {
        throw syntaxError(`Mismatched closing block '/${closing}'; expected '/${frame.node.kind}'`, location);
      }
      stack.pop();
      current = frame.parent;
      continue;
    }

    current.push({ kind: "value", path: tag, escaped: true, location });
  }

  const unclosed = stack.at(-1);
  if (unclosed) throw syntaxError(`Unclosed '#${unclosed.node.kind}' block`, unclosed.node.location);
  return root;
}

function property(value: unknown, segments: string[]): unknown {
  let current = value;
  for (const segment of segments) {
    if (current === null || current === undefined ||
        (typeof current !== "object" && typeof current !== "function")) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function resolve(path: string, root: unknown, loops: EachContext[]): unknown {
  if (path === "this" || path.startsWith("this.")) {
    const loop = loops.at(-1);
    if (!loop) return undefined;
    return property(loop.value, path === "this" ? [] : path.slice(5).split("."));
  }
  if (path === "@index") return loops.at(-1)?.index;
  if (!path) return undefined;
  return property(root, path.split("."));
}

function isTruthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return value !== "" && value !== 0 && value !== false && value !== null && value !== undefined;
}

function scalar(value: unknown, path: string, location: Location): string {
  if (value === null || value === undefined) return "";
  switch (typeof value) {
    case "string": return value;
    case "number":
    case "bigint":
    case "boolean": return String(value);
    default: throw syntaxError(`Value '${path}' is not scalar text`, location);
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]!);
}

function renderNodes(nodes: Node[], root: unknown, loops: EachContext[]): string {
  let output = "";
  for (const node of nodes) {
    if (node.kind === "text") {
      output += node.value;
    } else if (node.kind === "value") {
      const text = scalar(resolve(node.path, root, loops), node.path, node.location);
      output += node.escaped ? escapeHtml(text) : text;
    } else if (node.kind === "if") {
      const branch = isTruthy(resolve(node.path, root, loops)) ? node.truthy : node.falsy;
      output += renderNodes(branch, root, loops);
    } else {
      const value = resolve(node.path, root, loops);
      if (Array.isArray(value) && value.length > 0) {
        for (let index = 0; index < value.length; index++) {
          output += renderNodes(node.body, root, [...loops, { value: value[index], index }]);
        }
      } else {
        output += renderNodes(node.empty, root, loops);
      }
    }
  }
  return output;
}

export function render(template: string, data: unknown): string {
  return renderNodes(parse(template), data, []);
}
