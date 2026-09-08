type Location = { line: number; column: number };

type TextNode = { kind: "text"; value: string };
type ValueNode = { kind: "value"; path: string; escaped: boolean; location: Location };
type BlockNode = {
  kind: "block";
  block: "if" | "each";
  path: string;
  truthy: Node[];
  falsy: Node[] | null;
  location: Location;
};
type Node = TextNode | ValueNode | BlockNode;

type Frame = { node: BlockNode; parent: Node[] };
type Context = { value: unknown; index?: number };

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

function requirePath(path: string, description: string, location: Location): string {
  if (!path) throw syntaxError(`${description} requires a path`, location);
  if (/\s/.test(path)) throw syntaxError(`Invalid path "${path}"`, location);
  return path;
}

function parse(template: string): Node[] {
  const root: Node[] = [];
  const stack: Frame[] = [];
  let current = root;
  let offset = 0;

  while (offset < template.length) {
    const open = template.indexOf("{{", offset);
    if (open < 0) {
      current.push({ kind: "text", value: template.slice(offset) });
      break;
    }
    if (open > offset) current.push({ kind: "text", value: template.slice(offset, open) });

    const triple = template.startsWith("{{{", open);
    const closeMarker = triple ? "}}}" : "}}";
    const contentStart = open + (triple ? 3 : 2);
    const close = template.indexOf(closeMarker, contentStart);
    const location = locationAt(template, open);
    if (close < 0) throw syntaxError("Unclosed tag", location);

    const raw = template.slice(contentStart, close).trim();
    offset = close + closeMarker.length;

    if (triple) {
      const path = requirePath(raw, "Interpolation", location);
      current.push({ kind: "value", path, escaped: false, location });
      continue;
    }
    if (raw.startsWith("!")) continue;

    if (raw.startsWith("#")) {
      const match = /^#([^\s]+)(?:\s+(.+))?$/.exec(raw);
      const name = match?.[1] ?? "";
      if (name !== "if" && name !== "each") {
        throw syntaxError(`Unknown block "${name || raw.slice(1)}"`, location);
      }
      const path = requirePath(match?.[2]?.trim() ?? "", `#${name}`, location);
      const node: BlockNode = {
        kind: "block",
        block: name,
        path,
        truthy: [],
        falsy: null,
        location,
      };
      current.push(node);
      stack.push({ node, parent: current });
      current = node.truthy;
      continue;
    }

    if (raw === "else") {
      const frame = stack.at(-1);
      if (!frame) throw syntaxError("else outside a block", location);
      if (frame.node.falsy) throw syntaxError("Duplicate else", location);
      frame.node.falsy = [];
      current = frame.node.falsy;
      continue;
    }

    if (raw.startsWith("/")) {
      const name = raw.slice(1).trim();
      if (!name || /\s/.test(name)) throw syntaxError(`Invalid closing tag "${raw}"`, location);
      const frame = stack.at(-1);
      if (!frame) throw syntaxError(`Closing /${name} without an open block`, location);
      if (name !== frame.node.block) {
        throw syntaxError(`Mismatched closing /${name}; expected /${frame.node.block}`, location);
      }
      stack.pop();
      current = frame.parent;
      continue;
    }

    const path = requirePath(raw, "Interpolation", location);
    current.push({ kind: "value", path, escaped: true, location });
  }

  const unclosed = stack.at(-1)?.node;
  if (unclosed) throw syntaxError(`Unclosed #${unclosed.block} block`, unclosed.location);
  return root;
}

function property(value: unknown, segments: string[]): unknown {
  let result = value;
  for (const segment of segments) {
    if ((typeof result !== "object" || result === null) && typeof result !== "function") return undefined;
    if (!(segment in result)) return undefined;
    result = (result as Record<string, unknown>)[segment];
  }
  return result;
}

function resolve(path: string, context: Context, root: unknown): unknown {
  if (path === "this") return context.value;
  if (path === "@index") return context.index;
  if (path.startsWith("this.")) return property(context.value, path.slice(5).split("."));
  if (path.startsWith("@")) return undefined;

  const segments = path.split(".");
  const local = property(context.value, segments);
  return local === undefined && context.value !== root ? property(root, segments) : local;
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
      throw syntaxError(`Value at "${path}" is not scalar and cannot be rendered`, location);
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

function truthy(value: unknown): boolean {
  return !(value === "" || value === 0 || value === false || value === null || value === undefined ||
    (Array.isArray(value) && value.length === 0));
}

function renderNodes(nodes: Node[], context: Context, root: unknown): string {
  let output = "";
  for (const node of nodes) {
    if (node.kind === "text") {
      output += node.value;
    } else if (node.kind === "value") {
      const value = scalar(resolve(node.path, context, root), node.path, node.location);
      output += node.escaped ? escapeHtml(value) : value;
    } else {
      const value = resolve(node.path, context, root);
      if (node.block === "if") {
        const branch = truthy(value) ? node.truthy : node.falsy;
        if (branch) output += renderNodes(branch, context, root);
      } else if (Array.isArray(value) && value.length > 0) {
        for (let index = 0; index < value.length; index++) {
          output += renderNodes(node.truthy, { value: value[index], index }, root);
        }
      } else if (node.falsy) {
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
