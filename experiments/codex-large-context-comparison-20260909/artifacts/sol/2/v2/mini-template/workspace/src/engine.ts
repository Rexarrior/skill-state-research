type Location = {
  index: number;
  line: number;
  column: number;
};

type TextNode = { type: "text"; value: string };
type ValueNode = {
  type: "value";
  path: string;
  escaped: boolean;
  location: Location;
};
type BlockNode = {
  type: "if" | "each";
  path: string;
  body: Node[];
  alternate: Node[];
  location: Location;
  hasElse: boolean;
};
type Node = TextNode | ValueNode | BlockNode;

type Frame = { block: BlockNode | null; nodes: Node[] };
type Scope = { value: unknown; index?: number; parent?: Scope };

export class TemplateError extends Error {
  readonly line: number;
  readonly column: number;

  constructor(message: string, location: Location) {
    super(`${message} at line ${location.line}, column ${location.column}`);
    this.name = "TemplateError";
    this.line = location.line;
    this.column = location.column;
  }
}

function locationAt(source: string, index: number): Location {
  let line = 1;
  let column = 1;
  for (let i = 0; i < index; i++) {
    if (source.charCodeAt(i) === 10) {
      line++;
      column = 1;
    } else {
      column++;
    }
  }
  return { index, line, column };
}

function syntaxError(source: string, index: number, message: string): never {
  throw new TemplateError(message, locationAt(source, index));
}

function requirePath(source: string, index: number, path: string, kind: string): string {
  const trimmed = path.trim();
  if (!trimmed) syntaxError(source, index, `${kind} requires a path`);
  return trimmed;
}

function parse(source: string): Node[] {
  const root: Node[] = [];
  const stack: Frame[] = [{ block: null, nodes: root }];
  let cursor = 0;

  while (cursor < source.length) {
    const start = source.indexOf("{{", cursor);
    const nodes = stack[stack.length - 1]!.nodes;
    if (start < 0) {
      nodes.push({ type: "text", value: source.slice(cursor) });
      cursor = source.length;
      break;
    }
    if (start > cursor) nodes.push({ type: "text", value: source.slice(cursor, start) });

    const triple = source.startsWith("{{{", start);
    const closing = triple ? "}}}" : "}}";
    const contentStart = start + (triple ? 3 : 2);
    const end = source.indexOf(closing, contentStart);
    if (end < 0) syntaxError(source, start, "Unclosed tag");
    const content = source.slice(contentStart, end).trim();
    cursor = end + closing.length;

    if (triple) {
      nodes.push({
        type: "value",
        path: requirePath(source, start, content, "Interpolation"),
        escaped: false,
        location: locationAt(source, start),
      });
      continue;
    }

    if (content.startsWith("!")) continue;

    if (content.startsWith("#")) {
      const declaration = content.slice(1).trim();
      const space = declaration.search(/\s/);
      const kind = space < 0 ? declaration : declaration.slice(0, space);
      const path = space < 0 ? "" : declaration.slice(space).trim();
      if (kind !== "if" && kind !== "each") {
        syntaxError(source, start, `Unknown block ${kind ? `"${kind}"` : "tag"}`);
      }
      const block: BlockNode = {
        type: kind,
        path: requirePath(source, start, path, `#${kind}`),
        body: [],
        alternate: [],
        location: locationAt(source, start),
        hasElse: false,
      };
      nodes.push(block);
      stack.push({ block, nodes: block.body });
      continue;
    }

    if (content === "else") {
      const frame = stack[stack.length - 1]!;
      if (!frame.block) syntaxError(source, start, "else outside a block");
      if (frame.block.hasElse) syntaxError(source, start, "Duplicate else");
      frame.block.hasElse = true;
      frame.nodes = frame.block.alternate;
      continue;
    }

    if (content.startsWith("/")) {
      const name = content.slice(1).trim();
      if (name !== "if" && name !== "each") {
        syntaxError(source, start, `Unknown closing block "${name}"`);
      }
      const frame = stack[stack.length - 1]!;
      if (!frame.block) syntaxError(source, start, `Closing ${name} without an open block`);
      if (frame.block.type !== name) {
        syntaxError(source, start, `Mismatched closing block: expected /${frame.block.type}, got /${name}`);
      }
      stack.pop();
      continue;
    }

    if (content.startsWith("else") && /\s/.test(content[4] ?? "")) {
      syntaxError(source, start, "Invalid else tag");
    }
    nodes.push({
      type: "value",
      path: requirePath(source, start, content, "Interpolation"),
      escaped: true,
      location: locationAt(source, start),
    });
  }

  if (stack.length > 1) {
    const block = stack[stack.length - 1]!.block!;
    throw new TemplateError(`Unclosed ${block.type} block`, block.location);
  }
  return root;
}

function readPath(base: unknown, path: string): { found: boolean; value: unknown } {
  let value = base;
  for (const part of path.split(".")) {
    if ((typeof value !== "object" || value === null) && typeof value !== "function") {
      return { found: false, value: undefined };
    }
    if (!Object.prototype.hasOwnProperty.call(value, part)) {
      return { found: false, value: undefined };
    }
    value = (value as Record<string, unknown>)[part];
  }
  return { found: true, value };
}

function resolve(path: string, scope: Scope, root: unknown): unknown {
  if (path === "this") return scope.value;
  if (path.startsWith("this.")) return readPath(scope.value, path.slice(5)).value;
  if (path === "@index") return scope.index;

  const local = readPath(scope.value, path);
  if (local.found) return local.value;
  return scope.value === root ? undefined : readPath(root, path).value;
}

function isTruthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return value !== "" && value !== 0 && value !== false && value != null;
}

function scalar(value: unknown, node: ValueNode): string {
  if (value == null) return "";
  if (typeof value === "object" || typeof value === "function") {
    throw new TemplateError(`Cannot render ${typeof value} value for "${node.path}" as text`, node.location);
  }
  return String(value);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      default: return "&#39;";
    }
  });
}

function renderNodes(nodes: Node[], scope: Scope, root: unknown): string {
  let output = "";
  for (const node of nodes) {
    if (node.type === "text") {
      output += node.value;
    } else if (node.type === "value") {
      const value = scalar(resolve(node.path, scope, root), node);
      output += node.escaped ? escapeHtml(value) : value;
    } else if (node.type === "if") {
      const branch = isTruthy(resolve(node.path, scope, root)) ? node.body : node.alternate;
      output += renderNodes(branch, scope, root);
    } else {
      const value = resolve(node.path, scope, root);
      if (Array.isArray(value) && value.length > 0) {
        for (let index = 0; index < value.length; index++) {
          output += renderNodes(node.body, { value: value[index], index, parent: scope }, root);
        }
      } else {
        output += renderNodes(node.alternate, scope, root);
      }
    }
  }
  return output;
}

/** Render a Mini Template string with the supplied data. */
export function render(template: string, data: unknown): string {
  const ast = parse(template);
  return renderNodes(ast, { value: data }, data);
}
