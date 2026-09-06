type Position = { line: number; column: number };

type Node =
  | { kind: "text"; value: string }
  | { kind: "value"; path: string; raw: boolean; position: Position }
  | {
      kind: "block";
      block: "if" | "each";
      path: string;
      truthy: Node[];
      alternate: Node[];
      position: Position;
    };

type BlockNode = Extract<Node, { kind: "block" }>;

type Frame = {
  node: BlockNode;
  parent: Node[];
  inElse: boolean;
};

type Scope = { value: unknown; index?: number };

/** A template syntax or rendering error. */
export class TemplateError extends Error {
  constructor(message: string, position?: Position) {
    super(position ? `${message} at line ${position.line}, column ${position.column}` : message);
    this.name = "TemplateError";
  }
}

function positionAt(source: string, offset: number): Position {
  let line = 1;
  let column = 1;
  for (let i = 0; i < offset; i++) {
    if (source.charCodeAt(i) === 10) {
      line++;
      column = 1;
    } else {
      column++;
    }
  }
  return { line, column };
}

function parse(template: string): Node[] {
  const root: Node[] = [];
  const stack: Frame[] = [];
  let output = root;
  let cursor = 0;

  while (cursor < template.length) {
    const start = template.indexOf("{{", cursor);
    if (start === -1) {
      output.push({ kind: "text", value: template.slice(cursor) });
      break;
    }
    if (start > cursor) output.push({ kind: "text", value: template.slice(cursor, start) });

    const raw = template.startsWith("{{{", start);
    const openerLength = raw ? 3 : 2;
    const closing = raw ? "}}}" : "}}";
    const end = template.indexOf(closing, start + openerLength);
    const position = positionAt(template, start);
    if (end === -1) throw new TemplateError("Unclosed tag", position);

    const tag = template.slice(start + openerLength, end).trim();
    cursor = end + closing.length;
    if (!tag) throw new TemplateError("Empty tag", position);

    if (raw) {
      output.push({ kind: "value", path: tag, raw: true, position });
      continue;
    }
    if (tag.startsWith("!")) continue;

    if (tag.startsWith("#")) {
      const match = /^#(if|each)\s+(.+)$/.exec(tag);
      if (!match) {
        const name = tag.slice(1).trim().split(/\s+/, 1)[0] || tag;
        throw new TemplateError(`Unknown or malformed block '${name}'`, position);
      }
      const node: BlockNode = {
        kind: "block",
        block: match[1] as "if" | "each",
        path: match[2].trim(),
        truthy: [],
        alternate: [],
        position,
      };
      output.push(node);
      stack.push({ node, parent: output, inElse: false });
      output = node.truthy;
      continue;
    }

    if (tag === "else") {
      const frame = stack.at(-1);
      if (!frame) throw new TemplateError("'else' outside a block", position);
      if (frame.inElse) throw new TemplateError("Duplicate 'else'", position);
      frame.inElse = true;
      output = frame.node.alternate;
      continue;
    }

    if (tag.startsWith("/")) {
      const name = tag.slice(1).trim();
      const frame = stack.at(-1);
      if (!frame) throw new TemplateError(`Closing '${name}' without an open block`, position);
      if (name !== frame.node.block) {
        throw new TemplateError(
          `Mismatched closing block '${name}'; expected '${frame.node.block}'`,
          position,
        );
      }
      stack.pop();
      output = frame.parent;
      continue;
    }

    output.push({ kind: "value", path: tag, raw: false, position });
  }

  const unclosed = stack.at(-1);
  if (unclosed) {
    throw new TemplateError(`Unclosed '${unclosed.node.block}' block`, unclosed.node.position);
  }
  return root;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

function lookup(base: unknown, parts: string[]): { found: boolean; value: unknown } {
  let value = base;
  for (const part of parts) {
    if (!isRecord(value) || !Object.prototype.hasOwnProperty.call(value, part)) {
      return { found: false, value: undefined };
    }
    value = value[part];
  }
  return { found: true, value };
}

function resolve(path: string, root: unknown, scopes: Scope[]): unknown {
  const scope = scopes.at(-1);
  if (path === "this" || path.startsWith("this.")) {
    if (!scope) return undefined;
    const parts = path === "this" ? [] : path.slice(5).split(".");
    return lookup(scope.value, parts).value;
  }
  if (path === "@index") return scope?.index;

  const parts = path.split(".");
  if (scope) {
    const local = lookup(scope.value, parts);
    if (local.found) return local.value;
  }
  return lookup(root, parts).value;
}

function isTruthy(value: unknown): boolean {
  if (value === "" || value === 0 || value === false || value == null) return false;
  if (Array.isArray(value) && value.length === 0) return false;
  return true;
}

function scalar(value: unknown, path: string, position: Position): string {
  if (value == null) return "";
  switch (typeof value) {
    case "string":
      return value;
    case "number":
    case "bigint":
    case "boolean":
      return String(value);
    default:
      throw new TemplateError(`Value '${path}' is not scalar and cannot be rendered`, position);
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case "\"": return "&quot;";
      default: return "&#39;";
    }
  });
}

function renderNodes(nodes: Node[], root: unknown, scopes: Scope[]): string {
  let result = "";
  for (const node of nodes) {
    if (node.kind === "text") {
      result += node.value;
    } else if (node.kind === "value") {
      const value = scalar(resolve(node.path, root, scopes), node.path, node.position);
      result += node.raw ? value : escapeHtml(value);
    } else {
      const value = resolve(node.path, root, scopes);
      if (node.block === "if") {
        result += renderNodes(isTruthy(value) ? node.truthy : node.alternate, root, scopes);
      } else if (Array.isArray(value) && value.length > 0) {
        for (let index = 0; index < value.length; index++) {
          result += renderNodes(node.truthy, root, [...scopes, { value: value[index], index }]);
        }
      } else {
        result += renderNodes(node.alternate, root, scopes);
      }
    }
  }
  return result;
}

/** Render a Mini Template string using the supplied data. */
export function render(template: string, data: unknown): string {
  return renderNodes(parse(template), data, []);
}
