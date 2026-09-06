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

type OpenBlock = Extract<Node, { kind: "block" }> & {
  parent: Node[];
  inElse: boolean;
};

type Context = { value: unknown; index?: number; parent?: Context };

const MISSING = Symbol("missing");

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

function validPath(path: string): boolean {
  return path === "this" || path === "@index" ||
    /^(?:this\.)?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(path);
}

function requirePath(path: string, description: string, location: Location): string {
  if (!path || !validPath(path)) {
    throw syntaxError(`Invalid ${description}${path ? ` '${path}'` : ""}`, location);
  }
  return path;
}

function parse(template: string): Node[] {
  const root: Node[] = [];
  const stack: OpenBlock[] = [];
  let current = root;
  let cursor = 0;

  while (cursor < template.length) {
    const start = template.indexOf("{{", cursor);
    if (start < 0) {
      current.push({ kind: "text", value: template.slice(cursor) });
      break;
    }
    if (start > cursor) current.push({ kind: "text", value: template.slice(cursor, start) });

    const triple = template.startsWith("{{{", start);
    const close = triple ? "}}}" : "}}";
    const end = template.indexOf(close, start + (triple ? 3 : 2));
    const location = locationAt(template, start);
    if (end < 0) throw syntaxError("Unclosed tag", location);

    const raw = template.slice(start + (triple ? 3 : 2), end).trim();
    cursor = end + close.length;
    if (!raw) throw syntaxError("Empty tag", location);

    if (triple) {
      current.push({
        kind: "value",
        path: requirePath(raw, "path", location),
        escaped: false,
        location,
      });
      continue;
    }

    if (raw.startsWith("!")) continue;

    if (raw.startsWith("#")) {
      const match = /^#(\S+)(?:\s+(.+?))?$/.exec(raw);
      const name = match?.[1] ?? "";
      if (name !== "if" && name !== "each") {
        throw syntaxError(`Unknown block '${name || raw.slice(1)}'`, location);
      }
      const path = requirePath(match?.[2]?.trim() ?? "", `${name} path`, location);
      const block: Extract<Node, { kind: "block" }> = {
        kind: "block",
        block: name,
        path,
        truthy: [],
        falsy: [],
        location,
      };
      current.push(block);
      stack.push(Object.assign(block, { parent: current, inElse: false }));
      current = block.truthy;
      continue;
    }

    if (raw === "else") {
      const open = stack.at(-1);
      if (!open) throw syntaxError("'else' outside a block", location);
      if (open.inElse) throw syntaxError("Duplicate 'else'", location);
      open.inElse = true;
      current = open.falsy;
      continue;
    }

    if (raw.startsWith("/")) {
      const name = raw.slice(1).trim();
      const open = stack.at(-1);
      if (!open) throw syntaxError(`Unexpected closing block '${name}'`, location);
      if (name !== open.block) {
        throw syntaxError(`Mismatched closing block '${name}'; expected '${open.block}'`, location);
      }
      stack.pop();
      current = open.parent;
      continue;
    }

    current.push({
      kind: "value",
      path: requirePath(raw, "path", location),
      escaped: true,
      location,
    });
  }

  const open = stack.at(-1);
  if (open) throw syntaxError(`Unclosed '${open.block}' block`, open.location);
  return root;
}

function property(value: unknown, parts: string[]): unknown | typeof MISSING {
  let result = value;
  for (const part of parts) {
    if ((typeof result !== "object" || result === null) && typeof result !== "function") {
      return MISSING;
    }
    if (!Object.prototype.hasOwnProperty.call(result, part)) return MISSING;
    result = (result as Record<string, unknown>)[part];
  }
  return result;
}

function resolve(path: string, context: Context, root: unknown): unknown {
  if (path === "this") return context.value;
  if (path === "@index") return context.index;

  if (path.startsWith("this.")) {
    const found = property(context.value, path.slice(5).split("."));
    return found === MISSING ? undefined : found;
  }

  const parts = path.split(".");
  const local = property(context.value, parts);
  if (local !== MISSING) return local;
  const global = property(root, parts);
  return global === MISSING ? undefined : global;
}

function isTruthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return value !== "" && value !== 0 && value !== false && value != null;
}

function scalar(value: unknown, path: string, location: Location): string {
  if (value == null) return "";
  switch (typeof value) {
    case "string":
    case "number":
    case "bigint":
    case "boolean":
      return String(value);
    default:
      throw syntaxError(`Value '${path}' cannot be rendered as scalar text`, location);
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[character]!);
}

function renderNodes(nodes: Node[], context: Context, root: unknown): string {
  let output = "";
  for (const node of nodes) {
    if (node.kind === "text") {
      output += node.value;
    } else if (node.kind === "value") {
      const text = scalar(resolve(node.path, context, root), node.path, node.location);
      output += node.escaped ? escapeHtml(text) : text;
    } else {
      const value = resolve(node.path, context, root);
      if (node.block === "if") {
        output += renderNodes(isTruthy(value) ? node.truthy : node.falsy, context, root);
      } else if (Array.isArray(value) && value.length > 0) {
        for (let index = 0; index < value.length; index++) {
          output += renderNodes(node.truthy, { value: value[index], index, parent: context }, root);
        }
      } else {
        output += renderNodes(node.falsy, context, root);
      }
    }
  }
  return output;
}

/** Render a Mini Template string with the supplied data. */
export function render(template: string, data: unknown): string {
  return renderNodes(parse(template), { value: data }, data);
}
