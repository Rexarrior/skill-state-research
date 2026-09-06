type Location = { offset: number; line: number; column: number };

type TextNode = { kind: "text"; value: string };
type ValueNode = { kind: "value"; path: string; escaped: boolean; location: Location };
type BlockNode = {
  kind: "block";
  name: "if" | "each";
  path: string;
  body: Node[];
  alternate: Node[] | null;
  location: Location;
};
type Node = TextNode | ValueNode | BlockNode;

type Context = { root: unknown; current: unknown; index?: number };

function locationAt(source: string, offset: number): Location {
  let line = 1;
  let lastNewline = -1;
  for (let i = 0; i < offset; i++) {
    if (source[i] === "\n") {
      line++;
      lastNewline = i;
    }
  }
  return { offset, line, column: offset - lastNewline };
}

function errorAt(source: string, offset: number, message: string): Error {
  const { line, column } = locationAt(source, offset);
  return new Error(`${message} at line ${line}, column ${column}`);
}

function validPath(path: string): boolean {
  return path === "this" || path === "@index" || /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(path);
}

function parse(template: string): Node[] {
  const root: Node[] = [];
  type Frame = { node: BlockNode; parent: Node[]; inElse: boolean };
  const stack: Frame[] = [];
  let target = root;
  let cursor = 0;

  const appendText = (value: string) => {
    if (value) target.push({ kind: "text", value });
  };

  while (cursor < template.length) {
    const opening = template.indexOf("{{", cursor);
    if (opening === -1) {
      appendText(template.slice(cursor));
      break;
    }
    appendText(template.slice(cursor, opening));
    const triple = template.startsWith("{{{", opening);
    const close = triple ? "}}}" : "}}";
    const contentStart = opening + (triple ? 3 : 2);
    const closing = template.indexOf(close, contentStart);
    if (closing === -1) throw errorAt(template, opening, "Unclosed tag");
    const raw = template.slice(contentStart, closing);
    const tag = raw.trim();
    cursor = closing + close.length;

    if (!tag || tag.startsWith("!")) continue;
    if (triple) {
      if (tag.startsWith("#") || tag.startsWith("/") || tag === "else") {
        throw errorAt(template, opening, "Block syntax is not allowed in a triple-mustache tag");
      }
      if (!validPath(tag)) throw errorAt(template, opening, `Invalid path '${tag}'`);
      target.push({ kind: "value", path: tag, escaped: false, location: locationAt(template, opening) });
      continue;
    }
    if (tag === "else") {
      const frame = stack[stack.length - 1];
      if (!frame) throw errorAt(template, opening, "'else' outside a block");
      if (frame.inElse) throw errorAt(template, opening, "Duplicate 'else' in block");
      frame.inElse = true;
      frame.node.alternate = [];
      target = frame.node.alternate;
      continue;
    }
    if (tag.startsWith("#")) {
      const match = /^#(\S+)\s+(.+)$/.exec(tag);
      if (!match) throw errorAt(template, opening, "Block requires a name and path");
      const [, name, path] = match;
      if (name !== "if" && name !== "each") throw errorAt(template, opening, `Unknown block '${name}'`);
      if (!validPath(path)) throw errorAt(template, opening, `Invalid path '${path}'`);
      const node: BlockNode = { kind: "block", name, path, body: [], alternate: null, location: locationAt(template, opening) };
      target.push(node);
      stack.push({ node, parent: target, inElse: false });
      target = node.body;
      continue;
    }
    if (tag.startsWith("/")) {
      const name = tag.slice(1).trim();
      const frame = stack[stack.length - 1];
      if (!frame) throw errorAt(template, opening, `Unexpected closing block '${name}'`);
      if (name !== frame.node.name) {
        throw errorAt(template, opening, `Mismatched closing block '${name}', expected '${frame.node.name}'`);
      }
      stack.pop();
      target = frame.parent;
      continue;
    }
    if (!validPath(tag)) throw errorAt(template, opening, `Invalid path '${tag}'`);
    target.push({ kind: "value", path: tag, escaped: true, location: locationAt(template, opening) });
  }
  const frame = stack[stack.length - 1];
  if (frame) throw errorAt(template, frame.node.location.offset, `Unclosed '${frame.node.name}' block`);
  return root;
}

function ownValue(value: unknown, key: string): unknown {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return undefined;
  return Object.prototype.hasOwnProperty.call(value, key) ? (value as Record<string, unknown>)[key] : undefined;
}

function resolve(path: string, context: Context): unknown {
  if (path === "this") return context.current;
  if (path === "@index") return context.index;
  const parts = path.split(".");
  let value = ownValue(context.current, parts[0]);
  if (value === undefined) value = ownValue(context.root, parts[0]);
  for (const part of parts.slice(1)) value = ownValue(value, part);
  return value;
}

function isTruthy(value: unknown): boolean {
  return !(value === false || value === null || value === undefined || value === 0 || value === "" || (Array.isArray(value) && value.length === 0));
}

function scalar(value: unknown, location: Location): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  throw new Error(`Cannot render ${typeof value} as text at line ${location.line}, column ${location.column}`);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

function renderNodes(nodes: Node[], context: Context): string {
  let output = "";
  for (const node of nodes) {
    if (node.kind === "text") output += node.value;
    else if (node.kind === "value") {
      const value = scalar(resolve(node.path, context), node.location);
      output += node.escaped ? escapeHtml(value) : value;
    } else {
      const value = resolve(node.path, context);
      if (node.name === "if") output += renderNodes(isTruthy(value) ? node.body : (node.alternate ?? []), context);
      else if (Array.isArray(value) && value.length > 0) {
        for (let index = 0; index < value.length; index++) output += renderNodes(node.body, { root: context.root, current: value[index], index });
      } else output += renderNodes(node.alternate ?? [], context);
    }
  }
  return output;
}

/** Renders a Mini Template string using the supplied data as the root context. */
export function render(template: string, data: unknown): string {
  if (typeof template !== "string") throw new TypeError("Template must be a string");
  return renderNodes(parse(template), { root: data, current: data });
}
