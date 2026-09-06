type Location = {
  line: number;
  column: number;
};

type TextNode = { type: "text"; value: string };
type ValueNode = {
  type: "value";
  path: string;
  escaped: boolean;
  location: Location;
};
type BlockNode = {
  type: "if" | "each";
  path: string;
  truthy: Node[];
  falsy: Node[];
  location: Location;
  elseSeen: boolean;
};
type Node = TextNode | ValueNode | BlockNode;

type Frame = {
  block: BlockNode;
  parent: Node[];
};

type Context = {
  root: unknown;
  current: unknown;
  index?: number;
};

const MISSING = Symbol("missing");

function locationAt(input: string, offset: number): Location {
  let line = 1;
  let column = 1;
  for (let i = 0; i < offset; i++) {
    if (input.charCodeAt(i) === 10) {
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

function parse(template: string): Node[] {
  const root: Node[] = [];
  const stack: Frame[] = [];
  let target = root;
  let cursor = 0;

  while (cursor < template.length) {
    const open = template.indexOf("{{", cursor);
    if (open === -1) {
      target.push({ type: "text", value: template.slice(cursor) });
      break;
    }
    if (open > cursor) {
      target.push({ type: "text", value: template.slice(cursor, open) });
    }

    const triple = template.startsWith("{{{", open);
    const closeToken = triple ? "}}}" : "}}";
    const contentStart = open + (triple ? 3 : 2);
    const close = template.indexOf(closeToken, contentStart);
    const location = locationAt(template, open);
    if (close === -1) {
      throw syntaxError("Unclosed template tag", location);
    }

    const tag = template.slice(contentStart, close).trim();
    cursor = close + closeToken.length;

    if (triple) {
      target.push({ type: "value", path: tag, escaped: false, location });
      continue;
    }
    if (tag.startsWith("!")) continue;

    if (tag.startsWith("#")) {
      const declaration = tag.slice(1).trim();
      const match = /^(if|each)(?:\s+(.+))?$/.exec(declaration);
      if (!match) {
        const name = declaration.split(/\s/, 1)[0] || "(empty)";
        throw syntaxError(`Unknown block '${name}'`, location);
      }
      const path = match[2]?.trim();
      if (!path) throw syntaxError(`Block '${match[1]}' requires a path`, location);

      const block: BlockNode = {
        type: match[1] as "if" | "each",
        path,
        truthy: [],
        falsy: [],
        location,
        elseSeen: false,
      };
      target.push(block);
      stack.push({ block, parent: target });
      target = block.truthy;
      continue;
    }

    if (tag === "else") {
      const frame = stack.at(-1);
      if (!frame) throw syntaxError("'else' outside a block", location);
      if (frame.block.elseSeen) throw syntaxError("Duplicate 'else'", location);
      frame.block.elseSeen = true;
      target = frame.block.falsy;
      continue;
    }

    if (tag.startsWith("/")) {
      const name = tag.slice(1).trim();
      const frame = stack.at(-1);
      if (!frame) throw syntaxError(`Unexpected closing block '${name}'`, location);
      if (name !== frame.block.type) {
        throw syntaxError(
          `Mismatched closing block '${name}'; expected '${frame.block.type}'`,
          location,
        );
      }
      stack.pop();
      target = frame.parent;
      continue;
    }

    target.push({ type: "value", path: tag, escaped: true, location });
  }

  const unclosed = stack.at(-1)?.block;
  if (unclosed) {
    throw syntaxError(`Unclosed block '${unclosed.type}'`, unclosed.location);
  }
  return root;
}

function property(value: unknown, part: string): unknown | typeof MISSING {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") {
    return MISSING;
  }
  if (!Object.prototype.hasOwnProperty.call(value, part)) return MISSING;
  return (value as Record<string, unknown>)[part];
}

function walk(value: unknown, parts: string[]): unknown | typeof MISSING {
  let result: unknown | typeof MISSING = value;
  for (const part of parts) {
    if (result === MISSING) return MISSING;
    result = property(result, part);
  }
  return result;
}

function resolve(path: string, context: Context): unknown | typeof MISSING {
  if (!path) return MISSING;
  if (path === "this") return context.current;
  if (path.startsWith("this.")) return walk(context.current, path.slice(5).split("."));
  if (path === "@index") return context.index === undefined ? MISSING : context.index;

  const parts = path.split(".");
  const local = walk(context.current, parts);
  if (local !== MISSING) return local;
  if (context.current !== context.root) return walk(context.root, parts);
  return MISSING;
}

function isTruthy(value: unknown | typeof MISSING): boolean {
  if (value === MISSING || value === undefined || value === null) return false;
  if (value === false || value === 0 || value === "") return false;
  if (Array.isArray(value) && value.length === 0) return false;
  return true;
}

function scalarText(value: unknown | typeof MISSING, node: ValueNode): string {
  if (value === MISSING || value === undefined || value === null) return "";
  switch (typeof value) {
    case "string":
      return value;
    case "number":
    case "bigint":
    case "boolean":
      return String(value);
    default:
      throw syntaxError(`Value '${node.path}' is not scalar text`, node.location);
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
    if (node.type === "text") {
      output += node.value;
    } else if (node.type === "value") {
      const text = scalarText(resolve(node.path, context), node);
      output += node.escaped ? escapeHtml(text) : text;
    } else if (node.type === "if") {
      output += renderNodes(
        isTruthy(resolve(node.path, context)) ? node.truthy : node.falsy,
        context,
      );
    } else {
      const value = resolve(node.path, context);
      if (Array.isArray(value) && value.length > 0) {
        for (let index = 0; index < value.length; index++) {
          output += renderNodes(node.truthy, {
            root: context.root,
            current: value[index],
            index,
          });
        }
      } else {
        output += renderNodes(node.falsy, context);
      }
    }
  }
  return output;
}

/** Render a Mini Template string using the supplied data. */
export function render(template: string, data: unknown): string {
  const nodes = parse(template);
  return renderNodes(nodes, { root: data, current: data });
}
