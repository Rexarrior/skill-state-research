type Position = {
  offset: number;
  line: number;
  column: number;
};

type TextNode = { kind: "text"; value: string };
type ValueNode = {
  kind: "value";
  path: string;
  escaped: boolean;
  position: Position;
};
type IfNode = {
  kind: "if";
  path: string;
  truthy: Node[];
  falsy: Node[];
  position: Position;
};
type EachNode = {
  kind: "each";
  path: string;
  items: Node[];
  empty: Node[];
  position: Position;
};
type Node = TextNode | ValueNode | IfNode | EachNode;
type BlockNode = IfNode | EachNode;

type Frame = {
  block: BlockNode | null;
  body: Node[];
  hasElse: boolean;
};

type Scope = {
  value: unknown;
  index?: number;
};

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

function positionAt(lineStarts: number[], offset: number): Position {
  let low = 0;
  let high = lineStarts.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (lineStarts[middle]! <= offset) low = middle + 1;
    else high = middle;
  }
  const lineIndex = low - 1;
  return { offset, line: lineIndex + 1, column: offset - lineStarts[lineIndex]! + 1 };
}

function requirePath(raw: string, position: Position): string {
  const path = raw.trim();
  if (
    path.length === 0 ||
    /\s/.test(path) ||
    path.startsWith(".") ||
    path.endsWith(".") ||
    path.includes("..")
  ) {
    throw new TemplateError(`Invalid path ${JSON.stringify(path)}`, position);
  }
  return path;
}

function parse(template: string): Node[] {
  const root: Node[] = [];
  const stack: Frame[] = [{ block: null, body: root, hasElse: false }];
  const lineStarts = [0];
  for (let i = 0; i < template.length; i += 1) {
    if (template.charCodeAt(i) === 10) lineStarts.push(i + 1);
  }
  let cursor = 0;

  while (cursor < template.length) {
    const opening = template.indexOf("{{", cursor);
    const frame = stack[stack.length - 1]!;

    if (opening === -1) {
      frame.body.push({ kind: "text", value: template.slice(cursor) });
      break;
    }

    if (opening > cursor) {
      frame.body.push({ kind: "text", value: template.slice(cursor, opening) });
    }

    const position = positionAt(lineStarts, opening);
    const triple = template.startsWith("{{{", opening);
    const contentStart = opening + (triple ? 3 : 2);
    const closingText = triple ? "}}}" : "}}";
    const closing = template.indexOf(closingText, contentStart);

    if (closing === -1) {
      throw new TemplateError("Unclosed tag", position);
    }

    const raw = template.slice(contentStart, closing);
    const tag = raw.trim();
    cursor = closing + closingText.length;

    if (triple) {
      frame.body.push({
        kind: "value",
        path: requirePath(tag, position),
        escaped: false,
        position,
      });
      continue;
    }

    if (tag.startsWith("!")) {
      continue;
    }

    if (tag === "else") {
      if (stack.length === 1) {
        throw new TemplateError("'else' outside a block", position);
      }
      const current = stack[stack.length - 1]!;
      if (current.hasElse) {
        throw new TemplateError("Duplicate 'else'", position);
      }
      current.hasElse = true;
      current.body = current.block!.kind === "if" ? current.block!.falsy : current.block!.empty;
      continue;
    }

    if (tag.startsWith("#")) {
      const match = /^#(\S+)(?:\s+([\s\S]*))?$/.exec(tag);
      const name = match?.[1] ?? tag.slice(1);
      if (name !== "if" && name !== "each") {
        throw new TemplateError(`Unknown block ${JSON.stringify(name)}`, position);
      }
      const path = requirePath(match?.[2] ?? "", position);
      const block: BlockNode =
        name === "if"
          ? { kind: "if", path, truthy: [], falsy: [], position }
          : { kind: "each", path, items: [], empty: [], position };
      frame.body.push(block);
      stack.push({
        block,
        body: block.kind === "if" ? block.truthy : block.items,
        hasElse: false,
      });
      continue;
    }

    if (tag.startsWith("/")) {
      const name = tag.slice(1).trim();
      if (stack.length === 1) {
        throw new TemplateError(`Closing ${JSON.stringify(name)} without an open block`, position);
      }
      const current = stack[stack.length - 1]!;
      if (name !== current.block!.kind) {
        throw new TemplateError(
          `Mismatched closing block ${JSON.stringify(name)}; expected ${JSON.stringify(current.block!.kind)}`,
          position,
        );
      }
      stack.pop();
      continue;
    }

    frame.body.push({
      kind: "value",
      path: requirePath(tag, position),
      escaped: true,
      position,
    });
  }

  if (stack.length > 1) {
    const open = stack[stack.length - 1]!.block!;
    throw new TemplateError(`Unclosed ${JSON.stringify(open.kind)} block`, open.position);
  }

  return root;
}

function getProperty(value: unknown, key: string): { found: boolean; value: unknown } {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    return { found: false, value: undefined };
  }

  if (!Object.prototype.hasOwnProperty.call(value, key)) {
    return { found: false, value: undefined };
  }

  return { found: true, value: (value as Record<string, unknown>)[key] };
}

function resolveFrom(value: unknown, parts: string[]): { found: boolean; value: unknown } {
  let current = value;
  for (const part of parts) {
    const result = getProperty(current, part);
    if (!result.found) return result;
    current = result.value;
  }
  return { found: true, value: current };
}

function resolve(path: string, root: unknown, scopes: Scope[]): unknown {
  const current = scopes.length > 0 ? scopes[scopes.length - 1]!.value : root;
  if (path === "this") return current;
  if (path.startsWith("this.")) {
    return resolveFrom(current, path.slice(5).split(".")).value;
  }
  if (path === "@index") return scopes.at(-1)?.index;

  const parts = path.split(".");
  for (let i = scopes.length - 1; i >= 0; i -= 1) {
    const result = resolveFrom(scopes[i]!.value, parts);
    if (result.found) return result.value;
  }
  return resolveFrom(root, parts).value;
}

function isTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === "") return false;
  if ((typeof value === "number" || typeof value === "bigint") && value === 0) return false;
  if (Array.isArray(value) && value.length === 0) return false;
  return true;
}

function scalarText(value: unknown, path: string, position: Position): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object" || typeof value === "function") {
    throw new TemplateError(`Value at ${JSON.stringify(path)} is not scalar text`, position);
  }
  return String(value);
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
  let output = "";

  for (const node of nodes) {
    if (node.kind === "text") {
      output += node.value;
      continue;
    }

    const value = resolve(node.path, root, scopes);
    if (node.kind === "value") {
      const text = scalarText(value, node.path, node.position);
      output += node.escaped ? escapeHtml(text) : text;
    } else if (node.kind === "if") {
      output += renderNodes(isTruthy(value) ? node.truthy : node.falsy, root, scopes);
    } else if (Array.isArray(value) && value.length > 0) {
      for (let index = 0; index < value.length; index += 1) {
        output += renderNodes(node.items, root, [...scopes, { value: value[index], index }]);
      }
    } else {
      output += renderNodes(node.empty, root, scopes);
    }
  }

  return output;
}

/** Render a Mini Template string with values from data. */
export function render(template: string, data: unknown): string {
  return renderNodes(parse(template), data, []);
}
