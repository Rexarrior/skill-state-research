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

type BlockNode = Extract<Node, { kind: "block" }>;

type Frame = {
  node: BlockNode | null;
  children: Node[];
  inElse: boolean;
};

type Context = {
  root: unknown;
  current: unknown;
  index: number | undefined;
};

function syntaxError(message: string, location: Location): Error {
  return new Error(`${message} at line ${location.line}, column ${location.column}`);
}

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

function parse(template: string): Node[] {
  const root: Node[] = [];
  const stack: Frame[] = [{ node: null, children: root, inElse: false }];
  let offset = 0;

  while (offset < template.length) {
    const start = template.indexOf("{{", offset);
    if (start === -1) {
      stack.at(-1)!.children.push({ kind: "text", value: template.slice(offset) });
      break;
    }
    if (start > offset) {
      stack.at(-1)!.children.push({ kind: "text", value: template.slice(offset, start) });
    }

    const location = locationAt(template, start);
    const triple = template.startsWith("{{{", start);
    const closing = triple ? "}}}" : "}}";
    const contentStart = start + (triple ? 3 : 2);
    const end = template.indexOf(closing, contentStart);
    if (end === -1) throw syntaxError("Unclosed tag", location);

    const tag = template.slice(contentStart, end).trim();
    offset = end + closing.length;
    const frame = stack.at(-1)!;

    if (triple) {
      frame.children.push({ kind: "value", path: tag, escaped: false, location });
      continue;
    }
    if (tag.startsWith("!")) continue;

    if (tag.startsWith("#")) {
      const match = /^#(if|each)(?:\s+(.+))$/.exec(tag);
      if (!match) {
        const name = tag.slice(1).split(/\s/, 1)[0] || "(empty)";
        throw syntaxError(`Unknown or malformed block '${name}'`, location);
      }
      const node: BlockNode = {
        kind: "block",
        block: match[1] as "if" | "each",
        path: match[2].trim(),
        truthy: [],
        falsy: [],
        location,
      };
      frame.children.push(node);
      stack.push({ node, children: node.truthy, inElse: false });
      continue;
    }

    if (tag === "else") {
      if (!frame.node) throw syntaxError("'else' outside a block", location);
      if (frame.inElse) throw syntaxError("Duplicate 'else'", location);
      frame.inElse = true;
      frame.children = frame.node.falsy;
      continue;
    }

    if (tag.startsWith("/")) {
      const name = tag.slice(1).trim();
      if (!frame.node) throw syntaxError(`Unexpected closing block '${name}'`, location);
      if (name !== frame.node.block) {
        throw syntaxError(
          `Mismatched closing block '${name}'; expected '${frame.node.block}'`,
          location,
        );
      }
      stack.pop();
      continue;
    }

    frame.children.push({ kind: "value", path: tag, escaped: true, location });
  }

  if (stack.length > 1) {
    const node = stack.at(-1)!.node!;
    throw syntaxError(`Unclosed block '${node.block}'`, node.location);
  }
  return root;
}

function property(value: unknown, parts: string[]): unknown {
  let current = value;
  for (const part of parts) {
    if ((typeof current !== "object" || current === null) && typeof current !== "function") {
      return undefined;
    }
    if (!Object.prototype.hasOwnProperty.call(current, part)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function resolve(path: string, context: Context): unknown {
  if (path === "this") return context.current;
  if (path === "@index") return context.index;

  if (path.startsWith("this.")) return property(context.current, path.slice(5).split("."));
  const parts = path.split(".");
  const local = property(context.current, parts);
  return local === undefined ? property(context.root, parts) : local;
}

function isTruthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return value !== "" && value !== 0 && value !== false && value !== null && value !== undefined;
}

function scalar(value: unknown, path: string, location: Location): string {
  if (value === null || value === undefined) return "";
  switch (typeof value) {
    case "string":
      return value;
    case "number":
    case "bigint":
    case "boolean":
      return String(value);
    default:
      throw syntaxError(`Value '${path}' is not scalar and cannot be rendered`, location);
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
  let output = "";
  for (const node of nodes) {
    if (node.kind === "text") {
      output += node.value;
    } else if (node.kind === "value") {
      const value = scalar(resolve(node.path, context), node.path, node.location);
      output += node.escaped ? escapeHtml(value) : value;
    } else if (node.block === "if") {
      output += renderNodes(isTruthy(resolve(node.path, context)) ? node.truthy : node.falsy, context);
    } else {
      const value = resolve(node.path, context);
      if (Array.isArray(value) && value.length > 0) {
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
