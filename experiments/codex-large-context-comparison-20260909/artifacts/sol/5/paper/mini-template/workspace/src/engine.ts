type Position = {
  index: number;
  line: number;
  column: number;
};

type TextNode = { type: "text"; value: string };
type ValueNode = { type: "value"; path: string; escaped: boolean; position: Position };
type IfNode = {
  type: "if";
  path: string;
  truthy: Node[];
  falsy: Node[];
  position: Position;
};
type EachNode = {
  type: "each";
  path: string;
  items: Node[];
  empty: Node[];
  position: Position;
};
type Node = TextNode | ValueNode | IfNode | EachNode;

type BlockNode = IfNode | EachNode;
type Frame = {
  node: BlockNode;
  parent: Node[];
  name: "if" | "each";
  hasElse: boolean;
};

type Scope = {
  root: unknown;
  current: unknown;
  index: number | undefined;
};

function positionAt(source: string, index: number): Position {
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

function syntaxError(message: string, position: Position): Error {
  return new Error(`${message} at line ${position.line}, column ${position.column}`);
}

function requirePath(text: string, kind: string, position: Position): string {
  const path = text.trim();
  if (!path) throw syntaxError(`${kind} requires a path`, position);
  if (/\s/.test(path)) throw syntaxError(`Invalid path in ${kind}: ${JSON.stringify(path)}`, position);
  return path;
}

function parse(template: string): Node[] {
  const root: Node[] = [];
  const stack: Frame[] = [];
  let target = root;
  let cursor = 0;

  while (cursor < template.length) {
    const open = template.indexOf("{{", cursor);
    if (open === -1) {
      target.push({ type: "text", value: template.slice(cursor) });
      break;
    }
    if (open > cursor) target.push({ type: "text", value: template.slice(cursor, open) });

    const position = positionAt(template, open);
    const triple = template.startsWith("{{{", open);
    const closeToken = triple ? "}}}" : "}}";
    const contentStart = open + (triple ? 3 : 2);
    const close = template.indexOf(closeToken, contentStart);
    if (close === -1) throw syntaxError("Unclosed tag", position);

    const raw = template.slice(contentStart, close);
    const tag = raw.trim();
    cursor = close + closeToken.length;

    if (triple) {
      const path = requirePath(tag, "Interpolation", position);
      target.push({ type: "value", path, escaped: false, position });
      continue;
    }
    if (!tag) throw syntaxError("Empty tag", position);
    if (tag.startsWith("!")) continue;

    if (tag.startsWith("#")) {
      const match = /^#(if|each)(?:\s+(.+))?$/.exec(tag);
      if (!match) throw syntaxError(`Unknown block ${JSON.stringify(tag)}`, position);
      const name = match[1] as "if" | "each";
      const path = requirePath(match[2] ?? "", `#${name}`, position);
      const node: BlockNode = name === "if"
        ? { type: "if", path, truthy: [], falsy: [], position }
        : { type: "each", path, items: [], empty: [], position };
      target.push(node);
      stack.push({ node, parent: target, name, hasElse: false });
      target = node.type === "if" ? node.truthy : node.items;
      continue;
    }

    if (tag === "else") {
      const frame = stack[stack.length - 1];
      if (!frame) throw syntaxError("else outside a block", position);
      if (frame.hasElse) throw syntaxError("Duplicate else", position);
      frame.hasElse = true;
      target = frame.node.type === "if" ? frame.node.falsy : frame.node.empty;
      continue;
    }

    if (tag.startsWith("/")) {
      const name = tag.slice(1).trim();
      const frame = stack[stack.length - 1];
      if (!frame) throw syntaxError(`Unexpected closing block /${name}`, position);
      if (name !== frame.name) {
        throw syntaxError(`Mismatched closing block /${name}; expected /${frame.name}`, position);
      }
      stack.pop();
      target = frame.parent;
      continue;
    }

    const path = requirePath(tag, "Interpolation", position);
    target.push({ type: "value", path, escaped: true, position });
  }

  const unclosed = stack[stack.length - 1];
  if (unclosed) throw syntaxError(`Unclosed block #${unclosed.name}`, unclosed.node.position);
  return root;
}

function own(object: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function walk(value: unknown, parts: string[]): { found: boolean; value: unknown } {
  let current = value;
  for (const part of parts) {
    if ((typeof current !== "object" || current === null) && typeof current !== "function") {
      return { found: false, value: undefined };
    }
    if (!own(current, part)) return { found: false, value: undefined };
    current = (current as Record<string, unknown>)[part];
  }
  return { found: true, value: current };
}

function resolve(path: string, scope: Scope): unknown {
  if (path === "this") return scope.current;
  if (path === "@index") return scope.index;

  const parts = path.split(".");
  if (parts.some((part) => !part)) return undefined;
  if (parts[0] === "this") return walk(scope.current, parts.slice(1)).value;

  const local = walk(scope.current, parts);
  if (local.found) return local.value;
  if (scope.current !== scope.root) return walk(scope.root, parts).value;
  return undefined;
}

function isTruthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return value !== "" && value !== 0 && value !== false && value !== null && value !== undefined;
}

function scalar(value: unknown, path: string, position: Position): string {
  if (value === null || value === undefined) return "";
  switch (typeof value) {
    case "string":
    case "number":
    case "bigint":
    case "boolean":
      return String(value);
    default:
      throw syntaxError(`Value at ${JSON.stringify(path)} cannot be rendered as scalar text`, position);
  }
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

function renderNodes(nodes: Node[], scope: Scope): string {
  let output = "";
  for (const node of nodes) {
    if (node.type === "text") {
      output += node.value;
    } else if (node.type === "value") {
      const text = scalar(resolve(node.path, scope), node.path, node.position);
      output += node.escaped ? escapeHtml(text) : text;
    } else if (node.type === "if") {
      output += renderNodes(isTruthy(resolve(node.path, scope)) ? node.truthy : node.falsy, scope);
    } else {
      const value = resolve(node.path, scope);
      if (Array.isArray(value) && value.length > 0) {
        for (let index = 0; index < value.length; index++) {
          output += renderNodes(node.items, { root: scope.root, current: value[index], index });
        }
      } else {
        output += renderNodes(node.empty, scope);
      }
    }
  }
  return output;
}

/** Render a Mini Template string using the supplied data. */
export function render(template: string, data: unknown): string {
  if (typeof template !== "string") throw new TypeError("Template must be a string");
  return renderNodes(parse(template), { root: data, current: data, index: undefined });
}
