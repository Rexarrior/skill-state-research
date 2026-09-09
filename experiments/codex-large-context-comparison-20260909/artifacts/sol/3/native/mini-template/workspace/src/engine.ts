type Position = {
  readonly index: number;
  readonly line: number;
  readonly column: number;
};

type TextNode = {
  readonly kind: "text";
  readonly value: string;
};

type ValueNode = {
  readonly kind: "value";
  readonly path: string;
  readonly escaped: boolean;
  readonly position: Position;
};

type BlockNode = {
  readonly kind: "if" | "each";
  readonly path: string;
  readonly consequent: Node[];
  readonly alternate: Node[];
  readonly position: Position;
};

type Node = TextNode | ValueNode | BlockNode;

type OpenBlock = {
  readonly node: BlockNode;
  readonly parent: Node[];
  inAlternate: boolean;
};

type Context = {
  readonly root: unknown;
  readonly current: unknown;
  readonly index: number | undefined;
};

type Lookup =
  | { readonly found: true; readonly value: unknown }
  | { readonly found: false; readonly value?: never };

/** An error caused by invalid template syntax or an unrenderable value. */
export class TemplateError extends Error {
  readonly line: number;
  readonly column: number;

  constructor(message: string, position: Position) {
    super(`Template error at line ${position.line}, column ${position.column}: ${message}`);
    this.name = "TemplateError";
    this.line = position.line;
    this.column = position.column;
  }
}

function positionAt(source: string, index: number): Position {
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

function validatePath(path: string, position: Position): string {
  if (path === "this" || path === "@index") return path;

  const parts = path.startsWith("this.") ? path.slice(5).split(".") : path.split(".");
  if (
    parts.length === 0 ||
    parts.some((part) => part.length === 0 || /\s|[{}]/u.test(part)) ||
    path.startsWith("@")
  ) {
    throw new TemplateError(`invalid path \"${path}\"`, position);
  }

  return path;
}

function parse(template: string): Node[] {
  const root: Node[] = [];
  const stack: OpenBlock[] = [];
  let output = root;
  let cursor = 0;

  while (cursor < template.length) {
    const opening = template.indexOf("{{", cursor);
    if (opening === -1) {
      output.push({ kind: "text", value: template.slice(cursor) });
      break;
    }

    if (opening > cursor) {
      output.push({ kind: "text", value: template.slice(cursor, opening) });
    }

    const triple = template.startsWith("{{{", opening);
    const closingText = triple ? "}}}" : "}}";
    const contentStart = opening + (triple ? 3 : 2);
    const closing = template.indexOf(closingText, contentStart);
    const position = positionAt(template, opening);

    if (closing === -1) {
      throw new TemplateError(`unclosed ${triple ? "triple interpolation" : "tag"}`, position);
    }

    const content = template.slice(contentStart, closing).trim();
    cursor = closing + closingText.length;

    if (triple) {
      output.push({
        kind: "value",
        path: validatePath(content, position),
        escaped: false,
        position,
      });
      continue;
    }

    if (content.startsWith("!")) continue;

    if (content === "else") {
      const open = stack.at(-1);
      if (open === undefined) {
        throw new TemplateError("else outside a block", position);
      }
      if (open.inAlternate) {
        throw new TemplateError(`duplicate else in ${open.node.kind} block`, position);
      }
      open.inAlternate = true;
      output = open.node.alternate;
      continue;
    }

    if (content.startsWith("#")) {
      const match = /^#([^\s]+)(?:\s+(.+))?$/u.exec(content);
      const blockKind = match?.[1];
      if (blockKind !== "if" && blockKind !== "each") {
        throw new TemplateError(`unknown block \"${blockKind ?? content.slice(1)}\"`, position);
      }
      const rawPath = match?.[2]?.trim();
      if (!rawPath) {
        throw new TemplateError(`${blockKind} block requires a path`, position);
      }

      const node: BlockNode = {
        kind: blockKind,
        path: validatePath(rawPath, position),
        consequent: [],
        alternate: [],
        position,
      };
      output.push(node);
      stack.push({ node, parent: output, inAlternate: false });
      output = node.consequent;
      continue;
    }

    if (content.startsWith("/")) {
      const closeName = content.slice(1).trim();
      if (closeName !== "if" && closeName !== "each") {
        throw new TemplateError(`unknown closing block \"${closeName}\"`, position);
      }

      const open = stack.at(-1);
      if (open === undefined) {
        throw new TemplateError(`closing ${closeName} without an open block`, position);
      }
      if (open.node.kind !== closeName) {
        throw new TemplateError(
          `mismatched closing block: expected /${open.node.kind}, found /${closeName}`,
          position,
        );
      }

      stack.pop();
      output = open.parent;
      continue;
    }

    output.push({
      kind: "value",
      path: validatePath(content, position),
      escaped: true,
      position,
    });
  }

  const unclosed = stack.at(-1);
  if (unclosed !== undefined) {
    throw new TemplateError(`unclosed ${unclosed.node.kind} block`, unclosed.node.position);
  }

  return root;
}

function propertyLookup(value: unknown, parts: readonly string[]): Lookup {
  let current = value;

  for (const part of parts) {
    if ((typeof current !== "object" || current === null) && typeof current !== "function") {
      return { found: false };
    }
    if (!Object.prototype.hasOwnProperty.call(current, part)) {
      return { found: false };
    }
    current = (current as Record<string, unknown>)[part];
  }

  return { found: true, value: current };
}

function lookup(path: string, context: Context): Lookup {
  if (path === "this") return { found: true, value: context.current };
  if (path === "@index") {
    return context.index === undefined
      ? { found: false }
      : { found: true, value: context.index };
  }

  if (path.startsWith("this.")) {
    return propertyLookup(context.current, path.slice(5).split("."));
  }

  const parts = path.split(".");
  const local = propertyLookup(context.current, parts);
  if (local.found || context.current === context.root) return local;
  return propertyLookup(context.root, parts);
}

function isTruthy(value: unknown): boolean {
  if (value === false || value === null || value === undefined || value === "") return false;
  if (typeof value === "number" && value === 0) return false;
  if (typeof value === "bigint" && value === 0n) return false;
  if (Array.isArray(value) && value.length === 0) return false;
  return true;
}

function scalarText(value: unknown, path: string, position: Position): string {
  if (value === null || value === undefined) return "";
  switch (typeof value) {
    case "string":
      return value;
    case "number":
    case "bigint":
    case "boolean":
      return String(value);
    default:
      throw new TemplateError(
        `value at \"${path}\" is ${typeof value === "object" ? "an object" : `a ${typeof value}`} and cannot be rendered as text`,
        position,
      );
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function renderNodes(nodes: readonly Node[], context: Context): string {
  let result = "";

  for (const node of nodes) {
    if (node.kind === "text") {
      result += node.value;
      continue;
    }

    const resolved = lookup(node.path, context);
    if (node.kind === "value") {
      if (!resolved.found) continue;
      const text = scalarText(resolved.value, node.path, node.position);
      result += node.escaped ? escapeHtml(text) : text;
      continue;
    }

    if (node.kind === "if") {
      const branch = resolved.found && isTruthy(resolved.value)
        ? node.consequent
        : node.alternate;
      result += renderNodes(branch, context);
      continue;
    }

    const values = resolved.found && Array.isArray(resolved.value) ? resolved.value : [];
    if (values.length === 0) {
      result += renderNodes(node.alternate, context);
      continue;
    }
    for (let index = 0; index < values.length; index += 1) {
      result += renderNodes(node.consequent, {
        root: context.root,
        current: values[index],
        index,
      });
    }
  }

  return result;
}

/** Render a Mini Template string with the supplied data. */
export function render(template: string, data: unknown): string {
  const nodes = parse(template);
  return renderNodes(nodes, { root: data, current: data, index: undefined });
}
