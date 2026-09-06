type Location = { offset: number; line: number; column: number };

type TextNode = { type: "text"; value: string };
type ValueNode = { type: "value"; path: string; escaped: boolean; location: Location };
type BlockNode = {
  type: "block";
  kind: "if" | "each";
  path: string;
  body: Node[];
  alternate: Node[];
  location: Location;
  hasElse: boolean;
};
type Node = TextNode | ValueNode | BlockNode;

type Frame = { node: BlockNode; target: Node[] };
type Context = { root: unknown; thisValue: unknown; index?: number };

function locationAt(source: string, offset: number): Location {
  let line = 1;
  let lastNewline = -1;
  for (let i = 0; i < offset; i += 1) {
    if (source[i] === "\n") {
      line += 1;
      lastNewline = i;
    }
  }
  return { offset, line, column: offset - lastNewline };
}

function syntaxError(source: string, offset: number, message: string): Error {
  const location = locationAt(source, offset);
  return new Error(`${message} at line ${location.line}, column ${location.column}`);
}

function parsePath(raw: string, source: string, offset: number): string {
  const path = raw.trim();
  if (!path) throw syntaxError(source, offset, "Expected a path");
  if (!/^(?:this|@index|[A-Za-z_$][\w$]*)(?:\.[A-Za-z_$][\w$]*)*$/.test(path)) {
    throw syntaxError(source, offset, `Invalid path '${path}'`);
  }
  return path;
}

function parse(template: string): Node[] {
  const root: Node[] = [];
  const stack: Frame[] = [];
  let current = root;
  let position = 0;

  const appendText = (value: string) => { if (value) current.push({ type: "text", value }); };

  while (position < template.length) {
    const start = template.indexOf("{{", position);
    if (start === -1) {
      appendText(template.slice(position));
      break;
    }
    appendText(template.slice(position, start));
    const triple = template.startsWith("{{{", start);
    const close = triple ? "}}}" : "}}";
    const contentStart = start + (triple ? 3 : 2);
    const end = template.indexOf(close, contentStart);
    if (end === -1) throw syntaxError(template, start, "Unclosed tag");
    const raw = template.slice(contentStart, end);
    const tag = raw.trim();
    const location = locationAt(template, start);
    position = end + close.length;

    if (triple) {
      if (tag.startsWith("#") || tag.startsWith("/") || tag === "else" || tag.startsWith("!")) {
        throw syntaxError(template, start, "Control tags cannot use triple braces");
      }
      current.push({ type: "value", path: parsePath(tag, template, start), escaped: false, location });
    } else if (tag.startsWith("!")) {
      continue;
    } else if (tag.startsWith("#")) {
      const match = /^#(if|each)\s+(.+)$/.exec(tag);
      if (!match) throw syntaxError(template, start, "Unknown or malformed block");
      const node: BlockNode = {
        type: "block", kind: match[1] as "if" | "each", path: parsePath(match[2], template, start),
        body: [], alternate: [], location, hasElse: false,
      };
      current.push(node);
      stack.push({ node, target: node.body });
      current = node.body;
    } else if (tag === "else") {
      const frame = stack.at(-1);
      if (!frame) throw syntaxError(template, start, "'else' outside a block");
      if (frame.node.hasElse) throw syntaxError(template, start, "Duplicate 'else'");
      frame.node.hasElse = true;
      frame.target = frame.node.alternate;
      current = frame.target;
    } else if (tag.startsWith("/")) {
      const kind = tag.slice(1).trim();
      const frame = stack.at(-1);
      if (!frame) throw syntaxError(template, start, `Unexpected closing block '${kind}'`);
      if (kind !== frame.node.kind) {
        throw syntaxError(template, start, `Mismatched closing block '${kind}', expected '${frame.node.kind}'`);
      }
      stack.pop();
      current = stack.at(-1)?.target ?? root;
    } else {
      current.push({ type: "value", path: parsePath(tag, template, start), escaped: true, location });
    }
  }
  if (stack.length) {
    const frame = stack.at(-1)!;
    throw syntaxError(template, frame.node.location.offset, `Unclosed '${frame.node.kind}' block`);
  }
  return root;
}

function lookup(path: string, context: Context): unknown {
  if (path === "this") return context.thisValue;
  if (path === "@index") return context.index;
  let value: unknown = context.root;
  for (const part of path.split(".")) {
    if (value === null || value === undefined || (typeof value !== "object" && typeof value !== "function")) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

function isTruthy(value: unknown): boolean {
  return !(value === false || value === null || value === undefined || value === 0 || value === "" || (Array.isArray(value) && value.length === 0));
}

function scalar(value: unknown, location: Location): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object" || typeof value === "function") {
    throw new Error(`Cannot render ${typeof value} as scalar text at line ${location.line}, column ${location.column}`);
  }
  return String(value);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

function renderNodes(nodes: Node[], context: Context): string {
  let output = "";
  for (const node of nodes) {
    if (node.type === "text") output += node.value;
    else if (node.type === "value") {
      const value = scalar(lookup(node.path, context), node.location);
      output += node.escaped ? escapeHtml(value) : value;
    } else {
      const value = lookup(node.path, context);
      if (node.kind === "if") output += renderNodes(isTruthy(value) ? node.body : node.alternate, context);
      else if (!Array.isArray(value)) {
        output += renderNodes(node.alternate, context);
      } else if (value.length === 0) {
        output += renderNodes(node.alternate, context);
      } else {
        for (let index = 0; index < value.length; index += 1) {
          output += renderNodes(node.body, { root: context.root, thisValue: value[index], index });
        }
      }
    }
  }
  return output;
}

/** Render a Mini Template string using a root data value. */
export function render(template: string, data: unknown): string {
  if (typeof template !== "string") throw new TypeError("Template must be a string");
  return renderNodes(parse(template), { root: data, thisValue: data });
}
