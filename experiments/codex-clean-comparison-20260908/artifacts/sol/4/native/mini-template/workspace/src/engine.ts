type Position = {
  line: number;
  column: number;
};

type TextNode = { type: "text"; value: string };
type ValueNode = { type: "value"; path: string; escaped: boolean; position: Position };
type BlockNode = {
  type: "if" | "each";
  path: string;
  truthy: Node[];
  falsy: Node[];
  position: Position;
};
type Node = TextNode | ValueNode | BlockNode;

type Frame = {
  block: BlockNode | null;
  nodes: Node[];
  sawElse: boolean;
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

function lineStartsFor(source: string): number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index++) {
    if (source.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
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
  return { line: lineIndex + 1, column: offset - lineStarts[lineIndex]! + 1 };
}

function requirePath(path: string, tagName: string, position: Position): string {
  if (path.length === 0) {
    throw new TemplateError(`${tagName} requires a path`, position);
  }
  return path;
}

function parse(template: string): Node[] {
  const root: Node[] = [];
  const frames: Frame[] = [{ block: null, nodes: root, sawElse: false }];
  const lineStarts = lineStartsFor(template);
  let cursor = 0;

  while (cursor < template.length) {
    const opening = template.indexOf("{{", cursor);
    if (opening === -1) {
      frames.at(-1)!.nodes.push({ type: "text", value: template.slice(cursor) });
      break;
    }

    if (opening > cursor) {
      frames.at(-1)!.nodes.push({ type: "text", value: template.slice(cursor, opening) });
    }

    const position = positionAt(lineStarts, opening);
    const triple = template.startsWith("{{{", opening);
    const terminator = triple ? "}}}" : "}}";
    const contentStart = opening + (triple ? 3 : 2);
    const closing = template.indexOf(terminator, contentStart);
    if (closing === -1) {
      throw new TemplateError("Unclosed tag", position);
    }

    const tag = template.slice(contentStart, closing).trim();
    cursor = closing + terminator.length;

    if (triple) {
      frames.at(-1)!.nodes.push({
        type: "value",
        path: requirePath(tag, "Interpolation", position),
        escaped: false,
        position,
      });
      continue;
    }

    if (tag.startsWith("!")) continue;

    if (tag === "else") {
      const frame = frames.at(-1)!;
      if (frame.block === null) throw new TemplateError("else outside a block", position);
      if (frame.sawElse) throw new TemplateError("Duplicate else", position);
      frame.sawElse = true;
      frame.nodes = frame.block.falsy;
      continue;
    }

    if (tag.startsWith("#")) {
      const match = /^#(if|each)(?:\s+(.+))?$/.exec(tag);
      if (!match) {
        const name = tag.slice(1).trim().split(/\s+/, 1)[0] || "(empty)";
        throw new TemplateError(`Unknown block ${name}`, position);
      }
      const type = match[1] as "if" | "each";
      const block: BlockNode = {
        type,
        path: requirePath(match[2]?.trim() ?? "", `#${type}`, position),
        truthy: [],
        falsy: [],
        position,
      };
      frames.at(-1)!.nodes.push(block);
      frames.push({ block, nodes: block.truthy, sawElse: false });
      continue;
    }

    if (tag.startsWith("/")) {
      const name = tag.slice(1).trim();
      const frame = frames.at(-1)!;
      if (frame.block === null) throw new TemplateError(`Unexpected closing block /${name}`, position);
      if (name !== frame.block.type) {
        throw new TemplateError(
          `Mismatched closing block /${name}; expected /${frame.block.type}`,
          position,
        );
      }
      frames.pop();
      continue;
    }

    frames.at(-1)!.nodes.push({
      type: "value",
      path: requirePath(tag, "Interpolation", position),
      escaped: true,
      position,
    });
  }

  if (frames.length > 1) {
    const block = frames.at(-1)!.block!;
    throw new TemplateError(`Unclosed #${block.type} block`, block.position);
  }
  return root;
}

function property(value: unknown, key: string): { found: boolean; value: unknown } {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") {
    return { found: false, value: undefined };
  }
  if (!Object.prototype.hasOwnProperty.call(value, key)) {
    return { found: false, value: undefined };
  }
  return { found: true, value: (value as Record<string, unknown>)[key] };
}

function walk(value: unknown, parts: string[]): { found: boolean; value: unknown } {
  let current = value;
  for (const part of parts) {
    const result = property(current, part);
    if (!result.found) return result;
    current = result.value;
  }
  return { found: true, value: current };
}

function resolve(path: string, root: unknown, scopes: Scope[]): unknown {
  const parts = path.split(".");
  const current = scopes.at(-1);

  if (parts[0] === "this") {
    if (!current) return undefined;
    return parts.length === 1 ? current.value : walk(current.value, parts.slice(1)).value;
  }
  if (parts[0] === "@index") {
    if (!current || current.index === undefined) return undefined;
    return parts.length === 1 ? current.index : undefined;
  }

  if (current) {
    const local = walk(current.value, parts);
    if (local.found) return local.value;
  }
  return walk(root, parts).value;
}

function isTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === "") return false;
  if (typeof value === "number" && value === 0) return false;
  if (typeof value === "bigint" && value === 0n) return false;
  if (Array.isArray(value) && value.length === 0) return false;
  return true;
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
      throw new TemplateError(`Value at \"${path}\" is not scalar text`, position);
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
      continue;
    }
    if (node.type === "value") {
      const text = scalar(resolve(node.path, root, scopes), node.path, node.position);
      output += node.escaped ? escapeHtml(text) : text;
      continue;
    }

    const value = resolve(node.path, root, scopes);
    if (node.type === "if") {
      output += renderNodes(isTruthy(value) ? node.truthy : node.falsy, root, scopes);
    } else if (Array.isArray(value) && value.length > 0) {
      for (let index = 0; index < value.length; index++) {
        scopes.push({ value: value[index], index });
        output += renderNodes(node.truthy, root, scopes);
        scopes.pop();
      }
    } else {
      output += renderNodes(node.falsy, root, scopes);
    }
  }
  return output;
}

/** Render a Mini Template string using values from `data`. */
export function render(template: string, data: unknown): string {
  return renderNodes(parse(template), data, []);
}
