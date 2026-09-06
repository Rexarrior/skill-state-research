type Node = TextNode | InterpolationNode | BlockNode;

interface Position {
  index: number;
  line: number;
  column: number;
}

interface TextNode {
  type: "text";
  value: string;
}

interface InterpolationNode {
  type: "interpolation";
  path: string;
  escaped: boolean;
  position: Position;
}

interface BlockNode {
  type: "block";
  kind: "if" | "each";
  path: string;
  body: Node[];
  alternate: Node[];
  hasElse: boolean;
  position: Position;
}

interface OpenBlock {
  node: BlockNode;
  parent: Node[];
}

interface Context {
  root: unknown;
  current: unknown;
  index?: number;
}

function templateError(message: string, position: Position): Error {
  return new Error(`${message} at line ${position.line}, column ${position.column}`);
}

function positionAt(template: string, index: number): Position {
  let line = 1;
  let column = 1;
  for (let i = 0; i < index; i += 1) {
    if (template[i] === "\n") {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { index, line, column };
}

function validatePath(path: string, position: Position): string {
  const trimmed = path.trim();
  if (!trimmed) throw templateError("Expected a path", position);
  if (!/^(?:this|@index|[A-Za-z_$][\w$]*)(?:\.[A-Za-z_$][\w$]*)*$/.test(trimmed)) {
    throw templateError(`Invalid path \"${trimmed}\"`, position);
  }
  return trimmed;
}

function parse(template: string): Node[] {
  const root: Node[] = [];
  let target = root;
  const stack: OpenBlock[] = [];
  let cursor = 0;

  while (cursor < template.length) {
    const start = template.indexOf("{{", cursor);
    if (start === -1) {
      if (cursor < template.length) target.push({ type: "text", value: template.slice(cursor) });
      break;
    }
    if (start > cursor) target.push({ type: "text", value: template.slice(cursor, start) });

    const triple = template.startsWith("{{{", start);
    const close = triple ? "}}}" : "}}";
    const contentStart = start + (triple ? 3 : 2);
    const end = template.indexOf(close, contentStart);
    const position = positionAt(template, start);
    if (end === -1) throw templateError("Unclosed tag", position);
    const content = template.slice(contentStart, end).trim();
    cursor = end + close.length;

    if (triple) {
      target.push({ type: "interpolation", path: validatePath(content, position), escaped: false, position });
      continue;
    }
    if (content.startsWith("!")) continue;
    if (content === "else") {
      const open = stack[stack.length - 1];
      if (!open) throw templateError("else outside a block", position);
      if (open.node.hasElse) throw templateError("Duplicate else", position);
      open.node.hasElse = true;
      target = open.node.alternate;
      continue;
    }
    if (content.startsWith("#")) {
      const match = /^#(if|each)\s+(.+)$/.exec(content);
      if (!match) throw templateError(`Unknown block \"${content}\"`, position);
      const node: BlockNode = {
        type: "block", kind: match[1] as "if" | "each", path: validatePath(match[2], position),
        body: [], alternate: [], hasElse: false, position,
      };
      target.push(node);
      stack.push({ node, parent: target });
      target = node.body;
      continue;
    }
    if (content.startsWith("/")) {
      const kind = content.slice(1).trim();
      const open = stack[stack.length - 1];
      if (!open) throw templateError(`Unexpected closing block \"${kind}\"`, position);
      if (kind !== open.node.kind) {
        throw templateError(`Mismatched closing block \"${kind}\"; expected \"${open.node.kind}\"`, position);
      }
      stack.pop();
      target = open.parent;
      continue;
    }
    target.push({ type: "interpolation", path: validatePath(content, position), escaped: true, position });
  }
  if (stack.length > 0) {
    const open = stack[stack.length - 1].node;
    throw templateError(`Unclosed block \"${open.kind}\"`, open.position);
  }
  return root;
}

function lookup(path: string, context: Context): unknown {
  if (path === "this") return context.current;
  if (path === "@index") return context.index;
  const parts = path.split(".");
  let value: unknown = parts[0] === "this" ? context.current : context.root;
  if (parts[0] === "this") parts.shift();
  for (const part of parts) {
    if (value === null || value === undefined || (typeof value !== "object" && typeof value !== "function")) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

function isTruthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return Boolean(value);
}

function scalar(value: unknown, position: Position): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object" || typeof value === "function" || typeof value === "symbol") {
    throw templateError(`Cannot render ${typeof value} as scalar text`, position);
  }
  return String(value);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
  })[character] as string);
}

function renderNodes(nodes: Node[], context: Context): string {
  let output = "";
  for (const node of nodes) {
    if (node.type === "text") output += node.value;
    else if (node.type === "interpolation") {
      const value = scalar(lookup(node.path, context), node.position);
      output += node.escaped ? escapeHtml(value) : value;
    } else {
      const value = lookup(node.path, context);
      if (node.kind === "if") output += renderNodes(isTruthy(value) ? node.body : node.alternate, context);
      else if (Array.isArray(value) && value.length > 0) {
        value.forEach((item, index) => { output += renderNodes(node.body, { root: context.root, current: item, index }); });
      } else output += renderNodes(node.alternate, context);
    }
  }
  return output;
}

/** Renders a Mini Template string using the provided data as its root context. */
export function render(template: string, data: unknown): string {
  return renderNodes(parse(template), { root: data, current: data });
}
