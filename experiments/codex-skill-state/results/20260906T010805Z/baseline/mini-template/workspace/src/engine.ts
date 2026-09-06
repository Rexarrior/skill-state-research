type Position = {
  line: number;
  column: number;
};

type TextNode = {
  kind: "text";
  value: string;
};

type InterpolationNode = {
  kind: "interpolation";
  path: string;
  escaped: boolean;
  position: Position;
};

type BlockNode = {
  kind: "if" | "each";
  path: string;
  consequent: Node[];
  alternate: Node[];
  position: Position;
};

type Node = TextNode | InterpolationNode | BlockNode;

type OpenBlock = {
  node: BlockNode;
  parent: Node[];
  inAlternate: boolean;
};

type Context = {
  root: unknown;
  current: unknown;
  index: number | undefined;
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

function positionAt(source: string, index: number): Position {
  let line = 1;
  let column = 1;

  for (const character of source.slice(0, index)) {
    if (character === "\n") {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }

  return { line, column };
}

function errorAt(source: string, index: number, message: string): never {
  throw new TemplateError(message, positionAt(source, index));
}

function requirePath(source: string, index: number, path: string, tag: string): string {
  if (path.length === 0) {
    errorAt(source, index, `${tag} requires a path`);
  }
  if (path.split(".").some((part) => part.length === 0)) {
    errorAt(source, index, `Invalid path ${JSON.stringify(path)}`);
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
    if (closing === -1) {
      errorAt(template, opening, `Unclosed ${triple ? "triple interpolation" : "tag"}`);
    }

    const raw = template.slice(contentStart, closing);
    const tag = raw.trim();
    const position = positionAt(template, opening);
    cursor = closing + closingText.length;

    if (triple) {
      const path = requirePath(template, opening, tag, "Interpolation");
      output.push({ kind: "interpolation", path, escaped: false, position });
      continue;
    }

    if (tag.startsWith("!")) {
      continue;
    }

    if (tag === "else") {
      const frame = stack.at(-1);
      if (frame === undefined) {
        errorAt(template, opening, "else used outside a block");
      }
      if (frame.inAlternate) {
        errorAt(template, opening, "Duplicate else");
      }
      frame.inAlternate = true;
      output = frame.node.alternate;
      continue;
    }

    if (tag.startsWith("#")) {
      const match = /^#(if|each)(?:\s+([\s\S]+))?$/.exec(tag);
      if (match === null) {
        errorAt(template, opening, `Unknown block ${JSON.stringify(tag)}`);
      }
      const kind = match[1] as "if" | "each";
      const path = requirePath(template, opening, (match[2] ?? "").trim(), `#${kind}`);
      const node: BlockNode = { kind, path, consequent: [], alternate: [], position };
      output.push(node);
      stack.push({ node, parent: output, inAlternate: false });
      output = node.consequent;
      continue;
    }

    if (tag.startsWith("/")) {
      const name = tag.slice(1).trim();
      const frame = stack.at(-1);
      if (frame === undefined) {
        errorAt(template, opening, `Unexpected closing block ${JSON.stringify(name)}`);
      }
      if (name !== frame.node.kind) {
        errorAt(
          template,
          opening,
          `Mismatched closing block ${JSON.stringify(name)}; expected ${JSON.stringify(frame.node.kind)}`,
        );
      }
      stack.pop();
      output = frame.parent;
      continue;
    }

    if (tag.length === 0) {
      errorAt(template, opening, "Interpolation requires a path");
    }
    output.push({
      kind: "interpolation",
      path: requirePath(template, opening, tag, "Interpolation"),
      escaped: true,
      position,
    });
  }

  const frame = stack.at(-1);
  if (frame !== undefined) {
    throw new TemplateError(`Unclosed ${frame.node.kind} block`, frame.node.position);
  }

  return root;
}

function lookup(object: unknown, parts: string[]): { found: boolean; value: unknown } {
  let value = object;

  for (const part of parts) {
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

function resolve(path: string, context: Context): unknown {
  if (path === "this") {
    return context.current;
  }
  if (path === "@index") {
    return context.index;
  }

  const thisPrefix = "this.";
  if (path.startsWith(thisPrefix)) {
    return lookup(context.current, path.slice(thisPrefix.length).split(".")).value;
  }

  const parts = path.split(".");
  const local = lookup(context.current, parts);
  if (local.found) {
    return local.value;
  }
  return lookup(context.root, parts).value;
}

function isTruthy(value: unknown): boolean {
  if (value === "" || value === false || value === null || value === undefined) {
    return false;
  }
  if ((typeof value === "number" && value === 0) || (typeof value === "bigint" && value === 0n)) {
    return false;
  }
  if (Array.isArray(value) && value.length === 0) {
    return false;
  }
  return true;
}

function scalarText(value: unknown, path: string, position: Position): string {
  if (value === undefined || value === null) {
    return "";
  }

  switch (typeof value) {
    case "string":
      return value;
    case "number":
    case "bigint":
    case "boolean":
      return String(value);
    default:
      throw new TemplateError(`Value at ${JSON.stringify(path)} is not scalar text`, position);
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

function renderNodes(nodes: Node[], context: Context): string {
  let result = "";

  for (const node of nodes) {
    if (node.kind === "text") {
      result += node.value;
      continue;
    }

    if (node.kind === "interpolation") {
      const text = scalarText(resolve(node.path, context), node.path, node.position);
      result += node.escaped ? escapeHtml(text) : text;
      continue;
    }

    const value = resolve(node.path, context);
    if (node.kind === "if") {
      result += renderNodes(isTruthy(value) ? node.consequent : node.alternate, context);
      continue;
    }

    if (!Array.isArray(value) || value.length === 0) {
      result += renderNodes(node.alternate, context);
      continue;
    }

    for (let index = 0; index < value.length; index += 1) {
      result += renderNodes(node.consequent, {
        root: context.root,
        current: value[index],
        index,
      });
    }
  }

  return result;
}

export function render(template: string, data: unknown): string {
  const nodes = parse(template);
  return renderNodes(nodes, { root: data, current: data, index: undefined });
}
