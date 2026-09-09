type Location = {
  line: number;
  column: number;
};

type TextNode = { type: "text"; value: string };
type ValueNode = { type: "value"; path: string; escaped: boolean; location: Location };
type BlockNode = {
  type: "if" | "each";
  path: string;
  consequent: Node[];
  alternate: Node[];
  location: Location;
};
type Node = TextNode | ValueNode | BlockNode;

type OpenBlock = {
  node: BlockNode;
  parent: Node[];
  elseSeen: boolean;
};

type RenderContext = {
  root: unknown;
  current: unknown;
  index: number | undefined;
};

type LookupResult = { found: boolean; value: unknown };

function locationAt(source: string, offset: number): Location {
  let line = 1;
  let column = 1;

  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }

  return { line, column };
}

function syntaxError(message: string, location: Location): Error {
  return new Error(`${message} at line ${location.line}, column ${location.column}`);
}

function requirePath(path: string, kind: string, location: Location): string {
  if (!path || /\s/.test(path) || path.split(".").some((part) => part.length === 0)) {
    throw syntaxError(`Invalid ${kind} path`, location);
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
      output.push({ type: "text", value: template.slice(cursor) });
      break;
    }

    if (opening > cursor) {
      output.push({ type: "text", value: template.slice(cursor, opening) });
    }

    const triple = template.startsWith("{{{", opening);
    const closeToken = triple ? "}}}" : "}}";
    const contentStart = opening + (triple ? 3 : 2);
    const closing = template.indexOf(closeToken, contentStart);
    const location = locationAt(template, opening);

    if (closing === -1) {
      throw syntaxError("Unclosed tag", location);
    }

    const content = template.slice(contentStart, closing).trim();
    cursor = closing + closeToken.length;

    if (triple) {
      output.push({
        type: "value",
        path: requirePath(content, "interpolation", location),
        escaped: false,
        location,
      });
      continue;
    }

    if (content.startsWith("!")) {
      continue;
    }

    if (content === "else") {
      const open = stack[stack.length - 1];
      if (!open) {
        throw syntaxError("Unexpected else outside a block", location);
      }
      if (open.elseSeen) {
        throw syntaxError(`Duplicate else in ${open.node.type} block`, location);
      }
      open.elseSeen = true;
      output = open.node.alternate;
      continue;
    }

    if (content.startsWith("#")) {
      const match = /^#(\S+)(?:\s+(.+))?$/.exec(content);
      const name = match?.[1] ?? content.slice(1);
      if (name !== "if" && name !== "each") {
        throw syntaxError(`Unknown block "${name}"`, location);
      }
      const path = requirePath(match?.[2]?.trim() ?? "", `${name} block`, location);
      const node: BlockNode = {
        type: name,
        path,
        consequent: [],
        alternate: [],
        location,
      };
      output.push(node);
      stack.push({ node, parent: output, elseSeen: false });
      output = node.consequent;
      continue;
    }

    if (content.startsWith("/")) {
      const name = content.slice(1).trim();
      const open = stack[stack.length - 1];
      if (!open) {
        throw syntaxError(`Unexpected closing block "${name}"`, location);
      }
      if (name !== open.node.type) {
        throw syntaxError(
          `Mismatched closing block "${name}"; expected "${open.node.type}"`,
          location,
        );
      }
      stack.pop();
      output = open.parent;
      continue;
    }

    output.push({
      type: "value",
      path: requirePath(content, "interpolation", location),
      escaped: true,
      location,
    });
  }

  const unclosed = stack[stack.length - 1];
  if (unclosed) {
    throw syntaxError(`Unclosed ${unclosed.node.type} block`, unclosed.node.location);
  }

  return root;
}

function isPropertyContainer(value: unknown): value is Record<PropertyKey, unknown> {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

function lookupFrom(value: unknown, parts: string[]): LookupResult {
  let current = value;

  for (const part of parts) {
    if (!isPropertyContainer(current) || !Object.prototype.hasOwnProperty.call(current, part)) {
      return { found: false, value: undefined };
    }
    current = current[part];
  }

  return { found: true, value: current };
}

function lookup(path: string, context: RenderContext): LookupResult {
  if (path === "this") {
    return { found: true, value: context.current };
  }
  if (path.startsWith("this.")) {
    return lookupFrom(context.current, path.slice(5).split("."));
  }
  if (path === "@index") {
    return context.index === undefined
      ? { found: false, value: undefined }
      : { found: true, value: context.index };
  }

  const parts = path.split(".");
  const local = lookupFrom(context.current, parts);
  if (local.found) {
    return local;
  }
  if (context.current !== context.root) {
    return lookupFrom(context.root, parts);
  }
  return local;
}

function isTruthy(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (value === "" || value === false || value === null || value === undefined) {
    return false;
  }
  if ((typeof value === "number" && value === 0) || (typeof value === "bigint" && value === 0n)) {
    return false;
  }
  return true;
}

function scalarText(value: unknown, path: string, location: Location): string {
  if (value === null || value === undefined) {
    return "";
  }
  switch (typeof value) {
    case "string":
    case "boolean":
    case "number":
    case "bigint":
      return String(value);
    default:
      throw syntaxError(`Value at "${path}" cannot be rendered as scalar text`, location);
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

function renderNodes(nodes: Node[], context: RenderContext): string {
  let result = "";

  for (const node of nodes) {
    if (node.type === "text") {
      result += node.value;
      continue;
    }

    if (node.type === "value") {
      const resolved = lookup(node.path, context);
      const text = scalarText(resolved.value, node.path, node.location);
      result += node.escaped ? escapeHtml(text) : text;
      continue;
    }

    const resolved = lookup(node.path, context).value;
    if (node.type === "if") {
      result += renderNodes(isTruthy(resolved) ? node.consequent : node.alternate, context);
      continue;
    }

    if (!Array.isArray(resolved) || resolved.length === 0) {
      result += renderNodes(node.alternate, context);
      continue;
    }

    for (let index = 0; index < resolved.length; index += 1) {
      result += renderNodes(node.consequent, {
        root: context.root,
        current: resolved[index],
        index,
      });
    }
  }

  return result;
}

/** Render a Mini Template string with the supplied data. */
export function render(template: string, data: unknown): string {
  return renderNodes(parse(template), { root: data, current: data, index: undefined });
}
