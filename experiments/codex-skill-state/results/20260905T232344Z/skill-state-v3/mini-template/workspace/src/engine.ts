type Location = {
  line: number;
  column: number;
};

type TextNode = {
  type: "text";
  value: string;
};

type ValueNode = {
  type: "value";
  path: string;
  escaped: boolean;
  location: Location;
};

type BlockNode = {
  type: "block";
  kind: "if" | "each";
  path: string;
  truthy: Node[];
  falsy: Node[];
  location: Location;
};

type Node = TextNode | ValueNode | BlockNode;

type Frame = {
  block: BlockNode;
  output: Node[];
  inElse: boolean;
};

type EachContext = {
  value: unknown;
  index: number;
};

function describeLocation(location: Location): string {
  return `line ${location.line}, column ${location.column}`;
}

function syntaxError(message: string, location: Location): Error {
  return new Error(`${message} at ${describeLocation(location)}`);
}

function makeLocator(source: string): (offset: number) => Location {
  const lineStarts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source.charCodeAt(index) === 10) lineStarts.push(index + 1);
  }

  return (offset: number) => {
    let low = 0;
    let high = lineStarts.length;
    while (low + 1 < high) {
      const middle = (low + high) >>> 1;
      if (lineStarts[middle] <= offset) low = middle;
      else high = middle;
    }
    return { line: low + 1, column: offset - lineStarts[low] + 1 };
  };
}

function requirePath(path: string, label: string, location: Location): string {
  if (path.length === 0) throw syntaxError(`${label} requires a path`, location);
  return path;
}

function parse(template: string): Node[] {
  const root: Node[] = [];
  const stack: Frame[] = [];
  const locate = makeLocator(template);
  let output = root;
  let cursor = 0;

  while (cursor < template.length) {
    const open = template.indexOf("{{", cursor);
    if (open === -1) {
      output.push({ type: "text", value: template.slice(cursor) });
      break;
    }

    if (open > cursor) output.push({ type: "text", value: template.slice(cursor, open) });

    const triple = template.startsWith("{{{", open);
    const closeToken = triple ? "}}}" : "}}";
    const contentStart = open + (triple ? 3 : 2);
    const close = template.indexOf(closeToken, contentStart);
    const location = locate(open);
    if (close === -1) throw syntaxError("Unclosed tag", location);

    const content = template.slice(contentStart, close).trim();
    cursor = close + closeToken.length;

    if (triple) {
      output.push({
        type: "value",
        path: requirePath(content, "Interpolation", location),
        escaped: false,
        location,
      });
      continue;
    }

    if (content.startsWith("!")) continue;

    if (content === "else") {
      const frame = stack.at(-1);
      if (!frame) throw syntaxError("else outside a block", location);
      if (frame.inElse) throw syntaxError("Duplicate else", location);
      frame.inElse = true;
      frame.output = frame.block.falsy;
      output = frame.output;
      continue;
    }

    if (content.startsWith("#")) {
      const declaration = content.slice(1).trim();
      const separator = declaration.search(/\s/);
      const kind = (separator === -1 ? declaration : declaration.slice(0, separator)) as string;
      const path = separator === -1 ? "" : declaration.slice(separator).trim();
      if (kind !== "if" && kind !== "each") {
        throw syntaxError(`Unknown block ${kind ? `\"${kind}\"` : "type"}`, location);
      }
      const block: BlockNode = {
        type: "block",
        kind,
        path: requirePath(path, `${kind} block`, location),
        truthy: [],
        falsy: [],
        location,
      };
      output.push(block);
      const frame: Frame = { block, output: block.truthy, inElse: false };
      stack.push(frame);
      output = frame.output;
      continue;
    }

    if (content.startsWith("/")) {
      const kind = content.slice(1).trim();
      const frame = stack.at(-1);
      if (!frame) throw syntaxError(`Closing ${kind || "block"} without an open block`, location);
      if (kind !== frame.block.kind) {
        throw syntaxError(
          `Mismatched closing block: expected /${frame.block.kind}, received /${kind || "?"}`,
          location,
        );
      }
      stack.pop();
      output = stack.at(-1)?.output ?? root;
      continue;
    }

    output.push({
      type: "value",
      path: requirePath(content, "Interpolation", location),
      escaped: true,
      location,
    });
  }

  const unclosed = stack.at(-1)?.block;
  if (unclosed) {
    throw syntaxError(`Unclosed ${unclosed.kind} block`, unclosed.location);
  }
  return root;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

type Lookup = { found: boolean; value: unknown };

function lookup(value: unknown, path: string): Lookup {
  let current = value;
  for (const part of path.split(".")) {
    if (part.length === 0 || !isRecord(current) || !Object.prototype.hasOwnProperty.call(current, part)) {
      return { found: false, value: undefined };
    }
    current = current[part];
  }
  return { found: true, value: current };
}

function resolve(path: string, root: unknown, contexts: EachContext[]): unknown {
  const current = contexts.at(-1);
  if (path === "this") return current?.value;
  if (path.startsWith("this.")) return current ? lookup(current.value, path.slice(5)).value : undefined;
  if (path === "@index") return current?.index;

  if (current) {
    const local = lookup(current.value, path);
    if (local.found) return local.value;
  }
  return lookup(root, path).value;
}

function isTruthy(value: unknown): boolean {
  if (value === undefined || value === null || value === false || value === "") return false;
  if (typeof value === "number" && value === 0) return false;
  if (Array.isArray(value) && value.length === 0) return false;
  return true;
}

function scalarToString(value: unknown, path: string, location: Location): string {
  if (value === undefined || value === null) return "";
  switch (typeof value) {
    case "string":
      return value;
    case "number":
    case "bigint":
    case "boolean":
      return String(value);
    default:
      throw new Error(
        `Cannot render non-scalar value for \"${path}\" at ${describeLocation(location)}`,
      );
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

function renderNodes(nodes: Node[], root: unknown, contexts: EachContext[]): string {
  let result = "";
  for (const node of nodes) {
    if (node.type === "text") {
      result += node.value;
      continue;
    }

    const value = resolve(node.path, root, contexts);
    if (node.type === "value") {
      const text = scalarToString(value, node.path, node.location);
      result += node.escaped ? escapeHtml(text) : text;
      continue;
    }

    if (node.kind === "if") {
      result += renderNodes(isTruthy(value) ? node.truthy : node.falsy, root, contexts);
      continue;
    }

    if (!Array.isArray(value) || value.length === 0) {
      result += renderNodes(node.falsy, root, contexts);
      continue;
    }
    for (let index = 0; index < value.length; index += 1) {
      result += renderNodes(node.truthy, root, [...contexts, { value: value[index], index }]);
    }
  }
  return result;
}

/** Render a Mini Template string with the supplied data. */
export function render(template: string, data: unknown): string {
  return renderNodes(parse(template), data, []);
}
