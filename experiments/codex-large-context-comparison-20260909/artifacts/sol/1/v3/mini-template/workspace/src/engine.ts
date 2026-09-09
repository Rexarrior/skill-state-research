type Location = {
  index: number;
  line: number;
  column: number;
};

type TextNode = { type: "text"; value: string };
type ValueNode = { type: "value"; path: string; escaped: boolean; location: Location };
type IfNode = {
  type: "if";
  path: string;
  truthy: Node[];
  falsy: Node[];
  location: Location;
};
type EachNode = {
  type: "each";
  path: string;
  body: Node[];
  empty: Node[];
  location: Location;
};
type Node = TextNode | ValueNode | IfNode | EachNode;
type BlockNode = IfNode | EachNode;

type Frame = {
  kind: "root" | "if" | "each";
  nodes: Node[];
  block?: BlockNode;
  inElse: boolean;
};

type Scope = {
  value: unknown;
  index: number;
};

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

  for (let cursor = 0; cursor < index; cursor += 1) {
    if (source.charCodeAt(cursor) === 10) {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }

  return { index, line, column };
}

function parse(template: string): Node[] {
  const root: Node[] = [];
  const stack: Frame[] = [{ kind: "root", nodes: root, inElse: false }];
  let cursor = 0;

  const current = (): Frame => stack[stack.length - 1]!;

  while (cursor < template.length) {
    const start = template.indexOf("{{", cursor);
    if (start === -1) {
      current().nodes.push({ type: "text", value: template.slice(cursor) });
      break;
    }

    if (start > cursor) {
      current().nodes.push({ type: "text", value: template.slice(cursor, start) });
    }

    const triple = template.startsWith("{{{", start);
    const openerLength = triple ? 3 : 2;
    const closer = triple ? "}}}" : "}}";
    const end = template.indexOf(closer, start + openerLength);
    const location = locationAt(template, start);

    if (end === -1) {
      throw new TemplateError("Unclosed tag", location);
    }

    const tag = template.slice(start + openerLength, end).trim();
    cursor = end + closer.length;

    if (triple) {
      if (tag.length === 0) throw new TemplateError("Empty interpolation", location);
      current().nodes.push({ type: "value", path: tag, escaped: false, location });
      continue;
    }

    if (tag.startsWith("!")) continue;

    if (tag === "else") {
      const frame = current();
      if (frame.kind === "root") throw new TemplateError("'else' outside a block", location);
      if (frame.inElse) throw new TemplateError("Duplicate 'else'", location);
      frame.inElse = true;
      frame.nodes = frame.block!.type === "if" ? frame.block!.falsy : frame.block!.empty;
      continue;
    }

    if (tag.startsWith("#")) {
      const match = /^#(if|each)(?:\s+(.+))$/.exec(tag);
      if (!match) {
        const name = tag.slice(1).trim().split(/\s+/, 1)[0] || "(empty)";
        throw new TemplateError(`Unknown or malformed block '${name}'`, location);
      }

      const kind = match[1] as "if" | "each";
      const path = match[2]!.trim();
      if (path.length === 0) throw new TemplateError(`Missing path for '${kind}' block`, location);

      const block: BlockNode = kind === "if"
        ? { type: "if", path, truthy: [], falsy: [], location }
        : { type: "each", path, body: [], empty: [], location };
      current().nodes.push(block);
      stack.push({
        kind,
        block,
        nodes: block.type === "if" ? block.truthy : block.body,
        inElse: false,
      });
      continue;
    }

    if (tag.startsWith("/")) {
      const close = tag.slice(1).trim();
      if (close !== "if" && close !== "each") {
        throw new TemplateError(`Unknown closing block '${close || "(empty)"}'`, location);
      }
      const frame = current();
      if (frame.kind === "root") throw new TemplateError(`Unexpected closing block '${close}'`, location);
      if (frame.kind !== close) {
        throw new TemplateError(`Mismatched closing block: expected '/${frame.kind}', found '/${close}'`, location);
      }
      stack.pop();
      continue;
    }

    if (tag.length === 0) throw new TemplateError("Empty interpolation", location);
    current().nodes.push({ type: "value", path: tag, escaped: true, location });
  }

  if (stack.length > 1) {
    const frame = current();
    throw new TemplateError(`Unclosed '${frame.kind}' block`, frame.block!.location);
  }

  return root;
}

function getPath(base: unknown, path: string): { found: boolean; value: unknown } {
  if (path === "this" || path === ".") return { found: true, value: base };

  let value = base;
  for (const part of path.split(".")) {
    if (part.length === 0 || (typeof value !== "object" && typeof value !== "function") || value === null) {
      return { found: false, value: undefined };
    }
    if (!Object.prototype.hasOwnProperty.call(value, part)) return { found: false, value: undefined };
    value = (value as Record<string, unknown>)[part];
  }
  return { found: true, value };
}

function resolve(path: string, root: unknown, scopes: Scope[]): unknown {
  const scope = scopes[scopes.length - 1];
  if (path === "@index") return scope?.index;

  if (scope) {
    if (path === "this" || path === ".") return scope.value;
    if (path.startsWith("this.")) return getPath(scope.value, path.slice(5)).value;
    const local = getPath(scope.value, path);
    if (local.found) return local.value;
  }

  return getPath(root, path).value;
}

function isTruthy(value: unknown): boolean {
  if (value === "" || value === 0 || value === false || value === null || value === undefined) return false;
  if (Array.isArray(value) && value.length === 0) return false;
  return true;
}

function scalar(value: unknown, path: string, location: Location): string {
  if (value === null || value === undefined) return "";
  switch (typeof value) {
    case "string":
    case "number":
    case "boolean":
    case "bigint":
      return String(value);
    default:
      throw new TemplateError(`Value '${path}' cannot be rendered as scalar text (${typeof value})`, location);
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

function renderNodes(nodes: Node[], root: unknown, scopes: Scope[]): string {
  let output = "";

  for (const node of nodes) {
    if (node.type === "text") {
      output += node.value;
    } else if (node.type === "value") {
      const text = scalar(resolve(node.path, root, scopes), node.path, node.location);
      output += node.escaped ? escapeHtml(text) : text;
    } else if (node.type === "if") {
      const branch = isTruthy(resolve(node.path, root, scopes)) ? node.truthy : node.falsy;
      output += renderNodes(branch, root, scopes);
    } else {
      const value = resolve(node.path, root, scopes);
      if (Array.isArray(value) && value.length > 0) {
        for (let index = 0; index < value.length; index += 1) {
          output += renderNodes(node.body, root, [...scopes, { value: value[index], index }]);
        }
      } else {
        output += renderNodes(node.empty, root, scopes);
      }
    }
  }

  return output;
}

/** Parse and render a Mini Template string with the supplied data. */
export function render(template: string, data: unknown): string {
  return renderNodes(parse(template), data, []);
}
