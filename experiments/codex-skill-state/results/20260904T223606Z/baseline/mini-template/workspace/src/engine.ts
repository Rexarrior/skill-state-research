/** A small, dependency-free template renderer. */

type Node = TextNode | InterpolationNode | BlockNode;

interface TextNode {
  kind: "text";
  value: string;
}

interface InterpolationNode {
  kind: "interpolation";
  path: string;
  escaped: boolean;
  offset: number;
}

interface BlockNode {
  kind: "block";
  name: "if" | "each";
  path: string;
  body: Node[];
  alternate?: Node[];
  offset: number;
}

interface Frame {
  block: BlockNode;
  parent: Node[];
  elseSeen: boolean;
}

interface Context {
  root: unknown;
  current: unknown;
  index?: number;
}

function location(template: string, offset: number): string {
  let line = 1;
  let column = 1;
  for (let i = 0; i < offset; i += 1) {
    if (template[i] === "\n") {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return `line ${line}, column ${column}`;
}

function templateError(template: string, offset: number, message: string): Error {
  return new Error(`Template error at ${location(template, offset)}: ${message}`);
}

function addNode(target: Node[], node: Node): void {
  target.push(node);
}

function parse(template: string): Node[] {
  const root: Node[] = [];
  const frames: Frame[] = [];
  let target = root;
  let cursor = 0;

  while (cursor < template.length) {
    const start = template.indexOf("{{", cursor);
    if (start === -1) {
      addNode(target, { kind: "text", value: template.slice(cursor) });
      break;
    }
    if (start > cursor) {
      addNode(target, { kind: "text", value: template.slice(cursor, start) });
    }

    const triple = template.startsWith("{{{", start);
    const close = triple ? "}}}" : "}}";
    const contentStart = start + (triple ? 3 : 2);
    const end = template.indexOf(close, contentStart);
    if (end === -1) {
      throw templateError(template, start, "unclosed tag");
    }
    const content = template.slice(contentStart, end).trim();
    cursor = end + close.length;

    if (triple) {
      if (!content) throw templateError(template, start, "empty interpolation");
      addNode(target, { kind: "interpolation", path: content, escaped: false, offset: start });
      continue;
    }
    if (content.startsWith("!")) continue;

    if (content === "else") {
      const frame = frames.at(-1);
      if (!frame) throw templateError(template, start, "else outside a block");
      if (frame.elseSeen) throw templateError(template, start, "duplicate else");
      frame.elseSeen = true;
      frame.block.alternate = [];
      target = frame.block.alternate;
      continue;
    }

    if (content.startsWith("#")) {
      const match = /^#(\S+)\s+(.+)$/.exec(content);
      if (!match) throw templateError(template, start, "block requires a name and path");
      const [, name, path] = match;
      if (name !== "if" && name !== "each") {
        throw templateError(template, start, `unknown block '${name}'`);
      }
      const block: BlockNode = { kind: "block", name, path: path.trim(), body: [], offset: start };
      addNode(target, block);
      frames.push({ block, parent: target, elseSeen: false });
      target = block.body;
      continue;
    }

    if (content.startsWith("/")) {
      const name = content.slice(1).trim();
      const frame = frames.at(-1);
      if (!frame) throw templateError(template, start, `closing '${name}' without an open block`);
      if (name !== frame.block.name) {
        throw templateError(template, start, `mismatched closing '${name}' for '${frame.block.name}'`);
      }
      frames.pop();
      target = frame.parent;
      continue;
    }

    if (!content) throw templateError(template, start, "empty interpolation");
    addNode(target, { kind: "interpolation", path: content, escaped: true, offset: start });
  }

  const frame = frames.at(-1);
  if (frame) {
    throw templateError(template, frame.block.offset, `unclosed '${frame.block.name}' block`);
  }
  return root;
}

function getOwn(value: unknown, key: string): unknown {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return undefined;
  return Object.prototype.hasOwnProperty.call(value, key)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function resolve(path: string, context: Context): unknown {
  const parts = path.split(".");
  if (parts.some((part) => part.length === 0 || /\s/.test(part))) return undefined;

  let value: unknown;
  if (parts[0] === "this") {
    value = context.current;
    parts.shift();
  } else if (parts[0] === "@index") {
    value = context.index;
    parts.shift();
  } else {
    value = context.root;
  }
  for (const part of parts) value = getOwn(value, part);
  return value;
}

function isTruthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return Boolean(value);
}

function scalar(value: unknown, template: string, offset: number): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "object" || typeof value === "function") {
    throw templateError(template, offset, "cannot render an object or function as scalar text");
  }
  return String(value);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]!);
}

function renderNodes(nodes: Node[], context: Context, template: string): string {
  let output = "";
  for (const node of nodes) {
    if (node.kind === "text") {
      output += node.value;
    } else if (node.kind === "interpolation") {
      const value = scalar(resolve(node.path, context), template, node.offset);
      output += node.escaped ? escapeHtml(value) : value;
    } else if (node.name === "if") {
      output += renderNodes(isTruthy(resolve(node.path, context)) ? node.body : (node.alternate ?? []), context, template);
    } else {
      const value = resolve(node.path, context);
      if (Array.isArray(value) && value.length > 0) {
        value.forEach((item, index) => {
          output += renderNodes(node.body, { root: context.root, current: item, index }, template);
        });
      } else {
        output += renderNodes(node.alternate ?? [], context, template);
      }
    }
  }
  return output;
}

/** Render a Mini Template string with the supplied data object. */
export function render(template: string, data: unknown): string {
  return renderNodes(parse(template), { root: data, current: data }, template);
}
