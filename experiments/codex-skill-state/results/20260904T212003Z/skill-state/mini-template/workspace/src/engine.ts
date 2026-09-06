type Location = {
  line: number;
  column: number;
};

type Node =
  | { type: "text"; value: string }
  | { type: "value"; path: string; escaped: boolean; location: Location }
  | BlockNode;

type BlockNode = {
  type: "if" | "each";
  path: string;
  body: Node[];
  alternate: Node[];
  location: Location;
};

type Frame = {
  node: BlockNode;
  inAlternate: boolean;
};

const MISSING = Symbol("missing");

function describeLocation(location: Location): string {
  return `line ${location.line}, column ${location.column}`;
}

function templateError(message: string, location: Location): Error {
  return new Error(`${message} at ${describeLocation(location)}`);
}

function buildLineStarts(template: string): number[] {
  const starts = [0];
  for (let index = 0; index < template.length; index += 1) {
    if (template[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

function locationAt(offset: number, lineStarts: number[]): Location {
  let low = 0;
  let high = lineStarts.length;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (lineStarts[middle] <= offset) low = middle;
    else high = middle;
  }
  return { line: low + 1, column: offset - lineStarts[low] + 1 };
}

function validatePath(path: string, location: Location): string {
  if (!path) throw templateError("Expected a path", location);
  if (/\s/.test(path) || path.startsWith(".") || path.endsWith(".") || path.includes("..")) {
    throw templateError(`Invalid path \"${path}\"`, location);
  }
  return path;
}

function parse(template: string): Node[] {
  const root: Node[] = [];
  const stack: Frame[] = [];
  const lineStarts = buildLineStarts(template);
  let cursor = 0;

  const output = (): Node[] => {
    const frame = stack[stack.length - 1];
    if (!frame) return root;
    return frame.inAlternate ? frame.node.alternate : frame.node.body;
  };

  while (cursor < template.length) {
    const opening = template.indexOf("{{", cursor);
    if (opening === -1) {
      output().push({ type: "text", value: template.slice(cursor) });
      cursor = template.length;
      break;
    }

    if (opening > cursor) {
      output().push({ type: "text", value: template.slice(cursor, opening) });
    }

    const location = locationAt(opening, lineStarts);
    const triple = template.startsWith("{{{", opening);
    const closingMarker = triple ? "}}}" : "}}";
    const contentStart = opening + (triple ? 3 : 2);
    const closing = template.indexOf(closingMarker, contentStart);
    if (closing === -1) {
      throw templateError(`Unclosed ${triple ? "triple " : ""}tag`, location);
    }

    const tag = template.slice(contentStart, closing).trim();
    cursor = closing + closingMarker.length;

    if (triple) {
      output().push({
        type: "value",
        path: validatePath(tag, location),
        escaped: false,
        location,
      });
      continue;
    }

    if (tag.startsWith("!")) continue;

    if (tag.startsWith("#")) {
      const match = /^#([^\s]+)(?:\s+(.+))?$/.exec(tag);
      const kind = match?.[1];
      if (kind !== "if" && kind !== "each") {
        throw templateError(`Unknown block \"${kind ?? tag.slice(1)}\"`, location);
      }
      const path = validatePath(match?.[2]?.trim() ?? "", location);
      const node: BlockNode = {
        type: kind,
        path,
        body: [],
        alternate: [],
        location,
      };
      output().push(node);
      stack.push({ node, inAlternate: false });
      continue;
    }

    if (tag === "else" || tag.startsWith("else ")) {
      if (tag !== "else") throw templateError("The else tag cannot have an argument", location);
      const frame = stack[stack.length - 1];
      if (!frame) throw templateError("Else outside a block", location);
      if (frame.inAlternate) throw templateError("Duplicate else", location);
      frame.inAlternate = true;
      continue;
    }

    if (tag.startsWith("/")) {
      const name = tag.slice(1).trim();
      if (name !== "if" && name !== "each") {
        throw templateError(`Unknown closing block \"${name}\"`, location);
      }
      const frame = stack[stack.length - 1];
      if (!frame) throw templateError(`Closing ${name} without an open block`, location);
      if (frame.node.type !== name) {
        throw templateError(
          `Mismatched closing block: expected /${frame.node.type}, found /${name}`,
          location,
        );
      }
      stack.pop();
      continue;
    }

    output().push({
      type: "value",
      path: validatePath(tag, location),
      escaped: true,
      location,
    });
  }

  const unclosed = stack[stack.length - 1];
  if (unclosed) {
    throw templateError(`Unclosed ${unclosed.node.type} block`, unclosed.node.location);
  }
  return root;
}

function ownValue(value: unknown, parts: string[]): unknown | typeof MISSING {
  let current = value;
  for (const part of parts) {
    if ((typeof current !== "object" || current === null) && typeof current !== "function") {
      return MISSING;
    }
    if (!Object.prototype.hasOwnProperty.call(current, part)) return MISSING;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

type Context = {
  root: unknown;
  current: unknown;
  index: number | undefined;
};

function resolve(path: string, context: Context): unknown | typeof MISSING {
  const parts = path.split(".");
  if (parts[0] === "this") {
    return parts.length === 1 ? context.current : ownValue(context.current, parts.slice(1));
  }
  if (parts[0] === "@index") {
    return parts.length === 1 ? context.index ?? MISSING : ownValue(context.index, parts.slice(1));
  }

  const local = ownValue(context.current, parts);
  if (local !== MISSING) return local;
  if (context.current !== context.root) return ownValue(context.root, parts);
  return MISSING;
}

function isTruthy(value: unknown | typeof MISSING): boolean {
  if (value === MISSING || value === null || value === undefined || value === false) return false;
  if (value === "" || value === 0 || value === 0n) return false;
  if (Array.isArray(value) && value.length === 0) return false;
  return true;
}

function scalarText(value: unknown | typeof MISSING, path: string, location: Location): string {
  if (value === MISSING || value === null || value === undefined) return "";
  switch (typeof value) {
    case "string":
      return value;
    case "number":
    case "bigint":
    case "boolean":
      return String(value);
    default:
      throw templateError(`Value at \"${path}\" is not scalar text`, location);
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
    if (node.type === "text") {
      result += node.value;
      continue;
    }

    if (node.type === "value") {
      const text = scalarText(resolve(node.path, context), node.path, node.location);
      result += node.escaped ? escapeHtml(text) : text;
      continue;
    }

    const value = resolve(node.path, context);
    if (node.type === "if") {
      result += renderNodes(isTruthy(value) ? node.body : node.alternate, context);
      continue;
    }

    if (!Array.isArray(value) || value.length === 0) {
      result += renderNodes(node.alternate, context);
      continue;
    }
    for (let index = 0; index < value.length; index += 1) {
      result += renderNodes(node.body, { root: context.root, current: value[index], index });
    }
  }
  return result;
}

/** Render a Mini Template string using the supplied data. */
export function render(template: string, data: unknown): string {
  return renderNodes(parse(template), { root: data, current: data, index: undefined });
}
