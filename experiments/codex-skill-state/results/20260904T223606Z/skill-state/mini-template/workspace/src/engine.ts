type Node = TextNode | InterpolationNode | BlockNode;

interface Position {
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
  truthy: Node[];
  falsy: Node[];
  hasElse: boolean;
  position: Position;
}

interface OpenBlock {
  node: BlockNode;
  parent: Node[];
}

interface Context {
  root: unknown;
  value: unknown;
  index?: number;
}

function error(message: string, position: Position): Error {
  return new Error(`${message} at line ${position.line}, column ${position.column}`);
}

function positionAt(source: string, offset: number): Position {
  let line = 1;
  let column = 1;
  for (let i = 0; i < offset; i += 1) {
    if (source[i] === "\n") {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { line, column };
}

function parse(template: string): Node[] {
  const root: Node[] = [];
  let current = root;
  const stack: OpenBlock[] = [];
  let offset = 0;

  const addText = (value: string): void => {
    if (value) current.push({ type: "text", value });
  };

  while (offset < template.length) {
    const start = template.indexOf("{{", offset);
    if (start === -1) {
      addText(template.slice(offset));
      break;
    }
    addText(template.slice(offset, start));
    const position = positionAt(template, start);
    const triple = template.startsWith("{{{", start);
    const close = triple ? "}}}" : "}}";
    const contentStart = start + (triple ? 3 : 2);
    const end = template.indexOf(close, contentStart);
    if (end === -1) throw error("Unclosed tag", position);

    const content = template.slice(contentStart, end).trim();
    offset = end + close.length;
    if (!content) throw error("Empty tag", position);

    if (triple) {
      if (content.startsWith("#") || content.startsWith("/") || content === "else" || content.startsWith("!")) {
        throw error("Triple braces are only valid for interpolation", position);
      }
      current.push({ type: "interpolation", path: content, escaped: false, position });
      continue;
    }
    if (content.startsWith("!")) continue;
    if (content.startsWith("#")) {
      const match = /^#(if|each)\s+(.+)$/.exec(content);
      if (!match) throw error(`Unknown or malformed block '${content}'`, position);
      const node: BlockNode = {
        type: "block",
        kind: match[1] as "if" | "each",
        path: match[2].trim(),
        truthy: [],
        falsy: [],
        hasElse: false,
        position,
      };
      current.push(node);
      stack.push({ node, parent: current });
      current = node.truthy;
      continue;
    }
    if (content === "else") {
      const open = stack.at(-1);
      if (!open) throw error("'else' outside a block", position);
      if (open.node.hasElse) throw error("Duplicate 'else'", position);
      open.node.hasElse = true;
      current = open.node.falsy;
      continue;
    }
    if (content.startsWith("/")) {
      const closeKind = content.slice(1).trim();
      const open = stack.at(-1);
      if (!open) throw error(`Closing '${closeKind}' without an open block`, position);
      if (closeKind !== open.node.kind) {
        throw error(`Mismatched closing block '${closeKind}', expected '${open.node.kind}'`, position);
      }
      stack.pop();
      current = open.parent;
      continue;
    }
    current.push({ type: "interpolation", path: content, escaped: true, position });
  }

  const open = stack.at(-1);
  if (open) throw error(`Unclosed '${open.node.kind}' block`, open.node.position);
  return root;
}

function resolve(path: string, context: Context): unknown {
  if (path === "this") return context.value;
  if (path === "@index") return context.index;
  if (!path || path.startsWith("@")) return undefined;

  let value = context.root;
  for (const part of path.split(".")) {
    if (value === null || value === undefined || (typeof value !== "object" && typeof value !== "function")) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

function isTruthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return !(value === "" || value === 0 || value === false || value === null || value === undefined);
}

function scalar(value: unknown, position: Position): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object" || typeof value === "function" || typeof value === "symbol") {
    throw error(`Cannot render ${typeof value} as scalar text`, position);
  }
  return String(value);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character] as string);
}

function renderNodes(nodes: Node[], context: Context): string {
  let output = "";
  for (const node of nodes) {
    if (node.type === "text") output += node.value;
    else if (node.type === "interpolation") {
      const value = scalar(resolve(node.path, context), node.position);
      output += node.escaped ? escapeHtml(value) : value;
    } else {
      const value = resolve(node.path, context);
      if (node.kind === "if") output += renderNodes(isTruthy(value) ? node.truthy : node.falsy, context);
      else if (Array.isArray(value) && value.length > 0) {
        output += value.map((item, index) => renderNodes(node.truthy, { root: context.root, value: item, index })).join("");
      } else output += renderNodes(node.falsy, context);
    }
  }
  return output;
}

/** Renders a Mini Template string with the supplied root data object. */
export function render(template: string, data: unknown): string {
  return renderNodes(parse(template), { root: data, value: data });
}
