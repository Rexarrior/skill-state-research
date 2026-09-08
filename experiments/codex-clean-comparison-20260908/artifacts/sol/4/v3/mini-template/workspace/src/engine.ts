type Location = { line: number; column: number };

type Node =
  | { kind: "text"; value: string }
  | { kind: "value"; path: string; escaped: boolean; location: Location }
  | {
      kind: "block";
      block: "if" | "each";
      path: string;
      truthy: Node[];
      falsy: Node[];
      location: Location;
    };

type Frame = {
  node: Extract<Node, { kind: "block" }>;
  parent: Node[];
  inElse: boolean;
};

type Context = { root: unknown; current: unknown; index?: number };

function locationAt(source: string, offset: number): Location {
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

function syntaxError(message: string, location: Location): Error {
  return new Error(`${message} at line ${location.line}, column ${location.column}`);
}

function validatePath(path: string, location: Location): void {
  if (!path || (!/^@index$/.test(path) && !/^this(?:\.[A-Za-z_$][\w$]*)*$/.test(path) && !/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(path))) {
    throw syntaxError(`Invalid path "${path}"`, location);
  }
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

    const triple = template.startsWith("{{{", start);
    const close = triple ? "}}}" : "}}";
    const contentStart = start + (triple ? 3 : 2);
    const end = template.indexOf(close, contentStart);
    const location = locationAt(template, start);
    if (end === -1) throw syntaxError("Unclosed tag", location);

    const raw = template.slice(contentStart, end).trim();
    cursor = end + close.length;
    if (!raw) throw syntaxError("Empty tag", location);
    if (triple && /^[#\/!]|^else$/.test(raw)) {
      throw syntaxError("Structural tags cannot use triple braces", location);
    }

    if (!triple && raw.startsWith("!")) continue;

    if (!triple && raw.startsWith("#")) {
      const match = raw.match(/^#(if|each)(?:\s+(.+))$/);
      if (!match) {
        const name = raw.slice(1).trim().split(/\s+/)[0] || "";
        throw syntaxError(`Unknown or malformed block "${name}"`, location);
      }
      const block = match[1] as "if" | "each";
      const path = match[2].trim();
      validatePath(path, location);
      const node: Extract<Node, { kind: "block" }> = {
        kind: "block",
        block,
        path,
        truthy: [],
        falsy: [],
        location,
      };
      output.push(node);
      stack.push({ node, parent: output, inElse: false });
      output = node.truthy;
      continue;
    }

    if (!triple && raw === "else") {
      const frame = stack.at(-1);
      if (!frame) throw syntaxError("Else outside a block", location);
      if (frame.inElse) throw syntaxError("Duplicate else", location);
      frame.inElse = true;
      output = frame.node.falsy;
      continue;
    }

    if (!triple && raw.startsWith("/")) {
      const closeName = raw.slice(1).trim();
      if (!/^(if|each)$/.test(closeName)) {
        throw syntaxError(`Unknown closing block "${closeName}"`, location);
      }
      const frame = stack.at(-1);
      if (!frame) throw syntaxError(`Closing ${closeName} without an open block`, location);
      if (frame.node.block !== closeName) {
        throw syntaxError(`Mismatched closing block: expected /${frame.node.block}, found /${closeName}`, location);
      }
      stack.pop();
      output = frame.parent;
      continue;
    }

    if (!triple && (raw.startsWith("#") || raw.startsWith("/"))) {
      throw syntaxError(`Unknown structural tag "${raw}"`, location);
    }
    validatePath(raw, location);
    output.push({ kind: "value", path: raw, escaped: !triple, location });
  }

  const unclosed = stack.at(-1)?.node;
  if (unclosed) throw syntaxError(`Unclosed ${unclosed.block} block`, unclosed.location);
  return root;
}

function getProperty(value: unknown, key: string): unknown {
  if (value === null || value === undefined || (typeof value !== "object" && typeof value !== "function")) return undefined;
  return Object.prototype.hasOwnProperty.call(value, key)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function follow(value: unknown, parts: string[]): unknown {
  for (const part of parts) value = getProperty(value, part);
  return value;
}

function resolve(path: string, context: Context): unknown {
  if (path === "@index") return context.index;
  if (path === "this") return context.current;
  if (path.startsWith("this.")) return follow(context.current, path.slice(5).split("."));
  return follow(context.root, path.split("."));
}

function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return !(value === "" || value === 0 || value === false || value === null || value === undefined);
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
      throw syntaxError(`Value at "${path}" cannot be rendered as scalar text`, location);
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '\"': "&quot;",
    "'": "&#39;",
  })[character]!);
}

function renderNodes(nodes: Node[], context: Context): string {
  let result = "";
  for (const node of nodes) {
    if (node.kind === "text") {
      result += node.value;
    } else if (node.kind === "value") {
      const value = scalar(resolve(node.path, context), node.path, node.location);
      result += node.escaped ? escapeHtml(value) : value;
    } else {
      const value = resolve(node.path, context);
      if (node.block === "if") {
        result += renderNodes(truthy(value) ? node.truthy : node.falsy, context);
      } else if (Array.isArray(value) && value.length > 0) {
        for (let index = 0; index < value.length; index++) {
          result += renderNodes(node.truthy, { root: context.root, current: value[index], index });
        }
      } else {
        result += renderNodes(node.falsy, context);
      }
    }
  }
  return result;
}

/** Render a Mini Template string with the supplied root data. */
export function render(template: string, data: unknown): string {
  return renderNodes(parse(template), { root: data, current: data });
}
