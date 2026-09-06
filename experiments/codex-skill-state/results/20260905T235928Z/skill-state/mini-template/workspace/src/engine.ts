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

type Context = {
  root: unknown;
  current: unknown;
  index: number | undefined;
};

const identifier = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function locationAt(source: string, offset: number): Location {
  const before = source.slice(0, offset);
  const lines = before.split("\n");
  return { line: lines.length, column: lines[lines.length - 1].length + 1 };
}

function syntaxError(message: string, location: Location): Error {
  return new Error(`${message} at line ${location.line}, column ${location.column}`);
}

function validatePath(path: string, location: Location): void {
  if (path === "this" || path === "@index") return;
  if (!path || !path.split(".").every((part) => identifier.test(part))) {
    throw syntaxError(`Invalid path "${path}"`, location);
  }
}

function parse(template: string): Node[] {
  const root: Node[] = [];
  let target = root;
  const stack: Frame[] = [];
  let cursor = 0;

  while (cursor < template.length) {
    const start = template.indexOf("{{", cursor);
    if (start === -1) {
      target.push({ kind: "text", value: template.slice(cursor) });
      break;
    }
    if (start > cursor) target.push({ kind: "text", value: template.slice(cursor, start) });

    const triple = template.startsWith("{{{", start);
    const close = triple ? "}}}" : "}}";
    const contentStart = start + (triple ? 3 : 2);
    const end = template.indexOf(close, contentStart);
    const location = locationAt(template, start);
    if (end === -1) throw syntaxError("Unclosed tag", location);

    const raw = template.slice(contentStart, end).trim();
    cursor = end + close.length;
    if (!raw) throw syntaxError("Empty tag", location);

    if (triple) {
      validatePath(raw, location);
      target.push({ kind: "value", path: raw, escaped: false, location });
      continue;
    }

    if (raw.startsWith("!")) continue;

    if (raw.startsWith("#")) {
      const match = /^#(if|each)\s+(.+)$/.exec(raw);
      if (!match) throw syntaxError(`Unknown or malformed block "${raw}"`, location);
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
      target.push(node);
      stack.push({ node, parent: target, inElse: false });
      target = node.truthy;
      continue;
    }

    if (raw === "else") {
      const frame = stack[stack.length - 1];
      if (!frame) throw syntaxError("else outside a block", location);
      if (frame.inElse) throw syntaxError("Duplicate else", location);
      frame.inElse = true;
      target = frame.node.falsy;
      continue;
    }

    if (raw.startsWith("/")) {
      const name = raw.slice(1).trim();
      if (name !== "if" && name !== "each") {
        throw syntaxError(`Unknown closing block "${raw}"`, location);
      }
      const frame = stack[stack.length - 1];
      if (!frame) throw syntaxError(`Closing ${name} without an open block`, location);
      if (frame.node.block !== name) {
        throw syntaxError(`Mismatched close: expected /${frame.node.block}, got /${name}`, location);
      }
      stack.pop();
      target = frame.parent;
      continue;
    }

    validatePath(raw, location);
    target.push({ kind: "value", path: raw, escaped: true, location });
  }

  const unclosed = stack[stack.length - 1];
  if (unclosed) {
    throw syntaxError(`Unclosed ${unclosed.node.block} block`, unclosed.node.location);
  }
  return root;
}

function property(object: unknown, key: string): { found: boolean; value: unknown } {
  if ((typeof object !== "object" && typeof object !== "function") || object === null) {
    return { found: false, value: undefined };
  }
  if (!Object.prototype.hasOwnProperty.call(object, key)) return { found: false, value: undefined };
  return { found: true, value: (object as Record<string, unknown>)[key] };
}

function walk(object: unknown, parts: string[]): { found: boolean; value: unknown } {
  let value = object;
  for (const part of parts) {
    const next = property(value, part);
    if (!next.found) return next;
    value = next.value;
  }
  return { found: true, value };
}

function resolve(path: string, context: Context): unknown {
  if (path === "this") return context.current;
  if (path === "@index") return context.index;
  const parts = path.split(".");
  const local = walk(context.current, parts);
  if (local.found) return local.value;
  return walk(context.root, parts).value;
}

function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return value !== "" && value !== 0 && value !== false && value !== null && value !== undefined;
}

function scalar(value: unknown, path: string, location: Location): string {
  if (value === null || value === undefined) return "";
  switch (typeof value) {
    case "string":
    case "number":
    case "bigint":
    case "boolean":
      return String(value);
    default:
      throw syntaxError(`Value at "${path}" is not scalar and cannot be rendered`, location);
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]!);
}

function renderNodes(nodes: Node[], context: Context): string {
  let output = "";
  for (const node of nodes) {
    if (node.kind === "text") {
      output += node.value;
    } else if (node.kind === "value") {
      const value = scalar(resolve(node.path, context), node.path, node.location);
      output += node.escaped ? escapeHtml(value) : value;
    } else {
      const value = resolve(node.path, context);
      if (node.block === "if") {
        output += renderNodes(truthy(value) ? node.truthy : node.falsy, context);
      } else if (Array.isArray(value) && value.length > 0) {
        for (let index = 0; index < value.length; index++) {
          output += renderNodes(node.truthy, { root: context.root, current: value[index], index });
        }
      } else {
        output += renderNodes(node.falsy, context);
      }
    }
  }
  return output;
}

/** Render a Mini Template string with the supplied data. */
export function render(template: string, data: unknown): string {
  return renderNodes(parse(template), { root: data, current: data, index: undefined });
}
