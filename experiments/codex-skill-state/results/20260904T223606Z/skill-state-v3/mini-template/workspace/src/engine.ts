type Location = { offset: number; line: number; column: number };

type Node =
  | { type: "text"; value: string }
  | { type: "value"; path: string; escaped: boolean; location: Location }
  | { type: "if" | "each"; path: string; body: Node[]; alternate: Node[]; location: Location };

type Frame = { node: Extract<Node, { type: "if" | "each" }>; target: Node[]; elseSeen: boolean };
type Context = { root: unknown; value: unknown; index?: number };

function error(message: string, at: Location): Error {
  return new Error(`${message} at line ${at.line}, column ${at.column}`);
}

function locationAt(source: string, offset: number): Location {
  const before = source.slice(0, offset);
  const line = before.split("\n").length;
  const lastNewline = before.lastIndexOf("\n");
  return { offset, line, column: offset - lastNewline };
}

function parse(template: string): Node[] {
  const root: Node[] = [];
  const stack: Frame[] = [];
  let target = root;
  let cursor = 0;

  const pushText = (value: string) => { if (value) target.push({ type: "text", value }); };
  while (cursor < template.length) {
    const open = template.indexOf("{{", cursor);
    if (open < 0) { pushText(template.slice(cursor)); break; }
    pushText(template.slice(cursor, open));
    const triple = template.startsWith("{{{", open);
    const closeMark = triple ? "}}}" : "}}";
    const contentStart = open + (triple ? 3 : 2);
    const close = template.indexOf(closeMark, contentStart);
    const at = locationAt(template, open);
    if (close < 0) throw error("Unclosed tag", at);
    const content = template.slice(contentStart, close).trim();
    cursor = close + closeMark.length;

    if (!content) throw error("Empty tag", at);
    if (content.startsWith("!")) continue;
    if (content === "else") {
      const frame = stack.at(-1);
      if (!frame) throw error("'else' outside a block", at);
      if (frame.elseSeen) throw error("Duplicate 'else'", at);
      frame.elseSeen = true;
      frame.target = frame.node.alternate;
      target = frame.target;
      continue;
    }
    if (content.startsWith("#")) {
      const match = /^#(if|each)\s+(.+)$/.exec(content);
      if (!match) throw error(`Unknown or malformed block '${content}'`, at);
      const node: Extract<Node, { type: "if" | "each" }> = {
        type: match[1] as "if" | "each", path: match[2].trim(), body: [], alternate: [], location: at,
      };
      target.push(node);
      stack.push({ node, target: node.body, elseSeen: false });
      target = node.body;
      continue;
    }
    if (content.startsWith("/")) {
      const name = content.slice(1).trim();
      const frame = stack.at(-1);
      if (!frame) throw error(`Closing '${name}' without an open block`, at);
      if (name !== frame.node.type) throw error(`Mismatched closing tag: expected '/${frame.node.type}', got '/${name}'`, at);
      stack.pop();
      target = stack.at(-1)?.target ?? root;
      continue;
    }
    target.push({ type: "value", path: content, escaped: !triple, location: at });
  }
  const unclosed = stack.at(-1);
  if (unclosed) throw error(`Unclosed '${unclosed.node.type}' block`, unclosed.node.location);
  return root;
}

function readPath(path: string, context: Context): unknown {
  if (path === "this") return context.value;
  if (path === "@index") return context.index;
  if (!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(path)) return undefined;
  let current: unknown = context.root;
  for (const part of path.split(".")) {
    if (current === null || current === undefined || (typeof current !== "object" && typeof current !== "function")) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function scalar(value: unknown, at: Location): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  throw error(`Cannot render ${typeof value} as text`, at);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

function truthy(value: unknown): boolean {
  return !(value === false || value === null || value === undefined || value === 0 || value === "" || (Array.isArray(value) && value.length === 0));
}

function renderNodes(nodes: Node[], context: Context): string {
  let result = "";
  for (const node of nodes) {
    if (node.type === "text") result += node.value;
    else if (node.type === "value") {
      const text = scalar(readPath(node.path, context), node.location);
      result += node.escaped ? escapeHtml(text) : text;
    } else if (node.type === "if") {
      result += renderNodes(truthy(readPath(node.path, context)) ? node.body : node.alternate, context);
    } else {
      const items = readPath(node.path, context);
      if (Array.isArray(items) && items.length) {
        for (let index = 0; index < items.length; index++) result += renderNodes(node.body, { root: context.root, value: items[index], index });
      } else result += renderNodes(node.alternate, context);
    }
  }
  return result;
}

/** Render a Mini Template string using a root data object. */
export function render(template: string, data: unknown): string {
  return renderNodes(parse(template), { root: data, value: data });
}
