type Position = {
  offset: number;
  line: number;
  column: number;
};

type TextNode = { type: "text"; value: string };
type ValueNode = {
  type: "value";
  path: string;
  escaped: boolean;
  position: Position;
};
type BlockNode = {
  type: "if" | "each";
  path: string;
  consequent: Node[];
  alternate: Node[];
  position: Position;
};
type Node = TextNode | ValueNode | BlockNode;

type Frame = {
  node: BlockNode;
  parent: Node[];
  inElse: boolean;
};

type Scope = {
  root: unknown;
  items: unknown[];
  indexes: number[];
};

const PATH_PATTERN = /^(?:@index|this(?:\.[^.\s]+)*|[^@.\s][^.\s]*(?:\.[^.\s]+)*)$/;

/** An error in a template, with a one-based source line and column. */
export class TemplateError extends Error {
  readonly line: number;
  readonly column: number;

  constructor(message: string, position: Position) {
    super(`${message} at line ${position.line}, column ${position.column}`);
    this.name = "TemplateError";
    this.line = position.line;
    this.column = position.column;
  }
}

function makePositionFinder(source: string): (offset: number) => Position {
  const lineStarts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 10) lineStarts.push(i + 1);
  }

  return (offset: number): Position => {
    let low = 0;
    let high = lineStarts.length;
    while (low + 1 < high) {
      const middle = (low + high) >>> 1;
      if (lineStarts[middle] <= offset) low = middle;
      else high = middle;
    }
    return { offset, line: low + 1, column: offset - lineStarts[low] + 1 };
  };
}

function assertPath(path: string, position: Position): void {
  if (!PATH_PATTERN.test(path)) {
    throw new TemplateError(`Invalid path ${JSON.stringify(path)}`, position);
  }
}

function parse(template: string): Node[] {
  const root: Node[] = [];
  const stack: Frame[] = [];
  let output = root;
  let cursor = 0;
  const positionAt = makePositionFinder(template);

  while (cursor < template.length) {
    const start = template.indexOf("{{", cursor);
    if (start === -1) {
      output.push({ type: "text", value: template.slice(cursor) });
      break;
    }

    if (start > cursor) {
      output.push({ type: "text", value: template.slice(cursor, start) });
    }

    const triple = template.startsWith("{{{", start);
    const close = triple ? "}}}" : "}}";
    const contentStart = start + (triple ? 3 : 2);
    const end = template.indexOf(close, contentStart);
    const position = positionAt(start);

    if (end === -1) {
      throw new TemplateError("Unclosed tag", position);
    }

    const content = template.slice(contentStart, end).trim();
    cursor = end + close.length;

    if (triple) {
      assertPath(content, position);
      output.push({ type: "value", path: content, escaped: false, position });
      continue;
    }

    if (content.startsWith("!")) {
      continue;
    }

    if (content.startsWith("#")) {
      const declaration = content.slice(1).trim();
      const match = /^(\S+)(?:\s+(.+))?$/.exec(declaration);
      const kind = match?.[1];
      const path = match?.[2]?.trim() ?? "";

      if (kind !== "if" && kind !== "each") {
        throw new TemplateError(`Unknown block ${JSON.stringify(kind ?? "")}`, position);
      }
      assertPath(path, position);

      const node: BlockNode = {
        type: kind,
        path,
        consequent: [],
        alternate: [],
        position,
      };
      output.push(node);
      stack.push({ node, parent: output, inElse: false });
      output = node.consequent;
      continue;
    }

    if (content === "else" || content.startsWith("else ")) {
      if (content !== "else") {
        throw new TemplateError("The else tag does not accept arguments", position);
      }
      const frame = stack.at(-1);
      if (!frame) {
        throw new TemplateError("Else outside a block", position);
      }
      if (frame.inElse) {
        throw new TemplateError("Duplicate else", position);
      }
      frame.inElse = true;
      output = frame.node.alternate;
      continue;
    }

    if (content.startsWith("/")) {
      const kind = content.slice(1).trim();
      const frame = stack.at(-1);
      if (!frame) {
        throw new TemplateError(`Closing ${JSON.stringify(kind)} without an open block`, position);
      }
      if (kind !== frame.node.type) {
        throw new TemplateError(
          `Mismatched closing block: expected /${frame.node.type}, found /${kind}`,
          position,
        );
      }
      stack.pop();
      output = frame.parent;
      continue;
    }

    assertPath(content, position);
    output.push({ type: "value", path: content, escaped: true, position });
  }

  const unclosed = stack.at(-1);
  if (unclosed) {
    throw new TemplateError(`Unclosed ${unclosed.node.type} block`, unclosed.node.position);
  }

  return root;
}

function lookupFrom(value: unknown, parts: string[]): { found: boolean; value: unknown } {
  let current = value;

  for (const part of parts) {
    if ((typeof current !== "object" || current === null) && typeof current !== "function") {
      return { found: false, value: undefined };
    }
    if (!Object.prototype.hasOwnProperty.call(current, part)) {
      return { found: false, value: undefined };
    }
    current = (current as Record<string, unknown>)[part];
  }

  return { found: true, value: current };
}

function resolve(path: string, scope: Scope): unknown {
  if (path === "@index") {
    return scope.indexes.at(-1);
  }

  if (path === "this") {
    return scope.items.length ? scope.items.at(-1) : scope.root;
  }

  if (path.startsWith("this.")) {
    const base = scope.items.length ? scope.items.at(-1) : scope.root;
    return lookupFrom(base, path.slice(5).split(".")).value;
  }

  const parts = path.split(".");
  if (scope.items.length) {
    const result = lookupFrom(scope.items.at(-1), parts);
    if (result.found) return result.value;
  }
  return lookupFrom(scope.root, parts).value;
}

function isTruthy(value: unknown): boolean {
  if (
    value === undefined || value === null || value === false || value === 0 || value === 0n || value === ""
  ) {
    return false;
  }
  return !Array.isArray(value) || value.length > 0;
}

function scalarText(value: unknown, position: Position): string {
  if (value === undefined || value === null) return "";

  switch (typeof value) {
    case "string":
      return value;
    case "number":
    case "bigint":
    case "boolean":
    case "symbol":
      return String(value);
    default:
      const description = Array.isArray(value)
        ? "an array"
        : typeof value === "object"
          ? "an object"
          : "a function";
      throw new TemplateError(
        `Cannot render ${description} value as scalar text`,
        position,
      );
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
  let result = "";

  for (const node of nodes) {
    if (node.type === "text") {
      result += node.value;
      continue;
    }

    if (node.type === "value") {
      const text = scalarText(resolve(node.path, scope), node.position);
      result += node.escaped ? escapeHtml(text) : text;
      continue;
    }

    const value = resolve(node.path, scope);
    if (node.type === "if") {
      result += renderNodes(isTruthy(value) ? node.consequent : node.alternate, scope);
      continue;
    }

    if (!Array.isArray(value) || value.length === 0) {
      result += renderNodes(node.alternate, scope);
      continue;
    }

    for (let index = 0; index < value.length; index++) {
      scope.items.push(value[index]);
      scope.indexes.push(index);
      try {
        result += renderNodes(node.consequent, scope);
      } finally {
        scope.items.pop();
        scope.indexes.pop();
      }
    }
  }

  return result;
}

/** Render a template using the supplied root data value. */
export function render(template: string, data: unknown): string {
  return renderNodes(parse(template), { root: data, items: [], indexes: [] });
}
