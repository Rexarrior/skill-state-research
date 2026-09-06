/** A small, dependency-free template renderer. */

type Position = { offset: number; line: number; column: number };

type TextNode = { type: "text"; value: string };
type ValueNode = { type: "value"; path: string; escaped: boolean; position: Position };
type BlockNode = {
  type: "block";
  kind: "if" | "each";
  path: string;
  body: Node[];
  alternate: Node[] | null;
  position: Position;
};
type Node = TextNode | ValueNode | BlockNode;

type OpenBlock = { node: BlockNode; parent: Node[]; inElse: boolean };
type Context = { value: unknown; index?: number };

function positionAt(template: string, offset: number): Position {
  const before = template.slice(0, offset);
  const line = before.split("\n").length;
  const lastNewline = before.lastIndexOf("\n");
  return { offset, line, column: offset - lastNewline };
}

function message(position: Position, text: string): string {
  return `${text} at line ${position.line}, column ${position.column}`;
}

function parsePath(raw: string, position: Position): string {
  const path = raw.trim();
  if (!path) throw new Error(message(position, "Expected a path"));
  return path;
}

function parse(template: string): Node[] {
  const root: Node[] = [];
  let current = root;
  const stack: OpenBlock[] = [];
  let cursor = 0;

  while (cursor < template.length) {
    const start = template.indexOf("{{", cursor);
    if (start === -1) {
      if (cursor < template.length) current.push({ type: "text", value: template.slice(cursor) });
      break;
    }
    if (start > cursor) current.push({ type: "text", value: template.slice(cursor, start) });

    const triple = template.startsWith("{{{", start);
    const close = triple ? "}}}" : "}}";
    const contentStart = start + (triple ? 3 : 2);
    const end = template.indexOf(close, contentStart);
    const position = positionAt(template, start);
    if (end === -1) throw new Error(message(position, "Unclosed tag"));
    const content = template.slice(contentStart, end).trim();
    cursor = end + close.length;

    if (triple) {
      current.push({ type: "value", path: parsePath(content, position), escaped: false, position });
      continue;
    }
    if (content.startsWith("!")) continue;
    if (content === "else") {
      const open = stack[stack.length - 1];
      if (!open) throw new Error(message(position, "'else' outside a block"));
      if (open.inElse) throw new Error(message(position, "Duplicate 'else'"));
      open.inElse = true;
      open.node.alternate = [];
      current = open.node.alternate;
      continue;
    }
    if (content.startsWith("#")) {
      const [kind, ...rest] = content.slice(1).trim().split(/\s+/);
      if (kind !== "if" && kind !== "each") {
        throw new Error(message(position, `Unknown block '${kind || ""}'`));
      }
      const node: BlockNode = {
        type: "block", kind, path: parsePath(rest.join(" "), position), body: [], alternate: null, position,
      };
      current.push(node);
      stack.push({ node, parent: current, inElse: false });
      current = node.body;
      continue;
    }
    if (content.startsWith("/")) {
      const kind = content.slice(1).trim();
      const open = stack[stack.length - 1];
      if (!open) throw new Error(message(position, `Unexpected closing block '${kind}'`));
      if (kind !== open.node.kind) {
        throw new Error(message(position, `Mismatched closing block '${kind}', expected '${open.node.kind}'`));
      }
      stack.pop();
      current = open.parent;
      continue;
    }
    current.push({ type: "value", path: parsePath(content, position), escaped: true, position });
  }

  const open = stack[stack.length - 1];
  if (open) throw new Error(message(open.node.position, `Unclosed '${open.node.kind}' block`));
  return root;
}

function getProperty(value: unknown, key: string): unknown {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "object" && typeof value !== "function") return undefined;
  return Object.prototype.hasOwnProperty.call(value, key)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function lookup(path: string, context: Context, root: unknown): unknown {
  if (path === "this") return context.value;
  if (path === "@index") return context.index;
  const keys = path.split(".");
  const resolve = (base: unknown): unknown => keys.reduce(getProperty, base);
  const local = resolve(context.value);
  return local === undefined && context.value !== root ? resolve(root) : local;
}

function isTruthy(value: unknown): boolean {
  return !(value === false || value === null || value === undefined || value === 0 || value === "" || (Array.isArray(value) && value.length === 0));
}

function stringify(value: unknown, position: Position): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  throw new Error(message(position, "Cannot render an object or function as scalar text"));
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

function renderNodes(nodes: Node[], context: Context, root: unknown): string {
  let output = "";
  for (const node of nodes) {
    if (node.type === "text") output += node.value;
    else if (node.type === "value") {
      const value = stringify(lookup(node.path, context, root), node.position);
      output += node.escaped ? escapeHtml(value) : value;
    } else {
      const value = lookup(node.path, context, root);
      if (node.kind === "if") output += renderNodes(isTruthy(value) ? node.body : (node.alternate ?? []), context, root);
      else if (Array.isArray(value) && value.length > 0) {
        value.forEach((item, index) => { output += renderNodes(node.body, { value: item, index }, root); });
      } else output += renderNodes(node.alternate ?? [], context, root);
    }
  }
  return output;
}

/** Render a template using data as its root context. */
export function render(template: string, data: unknown): string {
  if (typeof template !== "string") throw new TypeError("Template must be a string");
  return renderNodes(parse(template), { value: data }, data);
}
