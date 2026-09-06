type Location = {
  line: number;
  column: number;
};

type TextNode = {
  kind: "text";
  value: string;
};

type ValueNode = {
  kind: "value";
  path: string;
  escaped: boolean;
  location: Location;
};

type BlockNode = {
  kind: "block";
  blockType: "if" | "each";
  path: string;
  truthy: Node[];
  falsy: Node[];
  location: Location;
  hasElse: boolean;
};

type Node = TextNode | ValueNode | BlockNode;

type StackEntry = {
  block: BlockNode;
  parent: Node[];
};

type EachFrame = {
  value: unknown;
  index: number;
};

type RenderContext = {
  root: unknown;
  frames: EachFrame[];
};

const own = Object.prototype.hasOwnProperty;

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

function parse(template: string): Node[] {
  const root: Node[] = [];
  const stack: StackEntry[] = [];
  let current = root;
  let cursor = 0;

  while (cursor < template.length) {
    const opening = template.indexOf("{{", cursor);
    if (opening === -1) {
      current.push({ kind: "text", value: template.slice(cursor) });
      break;
    }

    if (opening > cursor) {
      current.push({ kind: "text", value: template.slice(cursor, opening) });
    }

    const location = locationAt(template, opening);
    const triple = template.startsWith("{{{", opening);
    const closingMarker = triple ? "}}}" : "}}";
    const contentStart = opening + (triple ? 3 : 2);
    const closing = template.indexOf(closingMarker, contentStart);

    if (closing === -1) {
      throw syntaxError("Unclosed template tag", location);
    }

    const tag = template.slice(contentStart, closing).trim();
    cursor = closing + closingMarker.length;

    if (triple) {
      if (tag.length === 0) {
        throw syntaxError("Interpolation path cannot be empty", location);
      }
      current.push({ kind: "value", path: tag, escaped: false, location });
      continue;
    }

    if (tag.startsWith("!")) {
      continue;
    }

    if (tag.startsWith("#")) {
      const match = /^#(if|each)\s+(.+)$/.exec(tag);
      if (!match) {
        const name = tag.slice(1).trim().split(/\s+/, 1)[0] || "(empty)";
        throw syntaxError(`Unknown or malformed block '${name}'`, location);
      }

      const block: BlockNode = {
        kind: "block",
        blockType: match[1] as "if" | "each",
        path: match[2].trim(),
        truthy: [],
        falsy: [],
        location,
        hasElse: false,
      };
      current.push(block);
      stack.push({ block, parent: current });
      current = block.truthy;
      continue;
    }

    if (tag === "else") {
      const entry = stack.at(-1);
      if (!entry) {
        throw syntaxError("'else' outside a block", location);
      }
      if (entry.block.hasElse) {
        throw syntaxError("Duplicate 'else'", location);
      }
      entry.block.hasElse = true;
      current = entry.block.falsy;
      continue;
    }

    if (tag.startsWith("/")) {
      const closingType = tag.slice(1).trim();
      const entry = stack.at(-1);
      if (!entry) {
        throw syntaxError(`Closing '${closingType}' without an open block`, location);
      }
      if (closingType !== entry.block.blockType) {
        throw syntaxError(
          `Mismatched closing block '${closingType}'; expected '${entry.block.blockType}'`,
          location,
        );
      }
      stack.pop();
      current = entry.parent;
      continue;
    }

    if (tag.length === 0) {
      throw syntaxError("Interpolation path cannot be empty", location);
    }

    current.push({ kind: "value", path: tag, escaped: true, location });
  }

  const unclosed = stack.at(-1)?.block;
  if (unclosed) {
    throw syntaxError(`Unclosed '${unclosed.blockType}' block`, unclosed.location);
  }

  return root;
}

function lookup(base: unknown, path: string): { found: boolean; value: unknown } {
  if (path === "") {
    return { found: true, value: base };
  }

  let value = base;
  for (const part of path.split(".")) {
    if ((typeof value !== "object" || value === null) && typeof value !== "function") {
      return { found: false, value: undefined };
    }
    if (!own.call(value, part)) {
      return { found: false, value: undefined };
    }
    value = (value as Record<string, unknown>)[part];
  }
  return { found: true, value };
}

function resolve(path: string, context: RenderContext): unknown {
  const frame = context.frames.at(-1);

  if (path === "this") {
    return frame?.value;
  }
  if (path.startsWith("this.")) {
    return frame ? lookup(frame.value, path.slice(5)).value : undefined;
  }
  if (path === "@index") {
    return frame?.index;
  }

  if (frame) {
    const local = lookup(frame.value, path);
    if (local.found) {
      return local.value;
    }
  }

  return lookup(context.root, path).value;
}

function isTruthy(value: unknown): boolean {
  if (value === "" || value === 0 || value === 0n || value === false || value == null) {
    return false;
  }
  if (Array.isArray(value) && value.length === 0) {
    return false;
  }
  return true;
}

function scalar(value: unknown, path: string, location: Location): string {
  if (value == null) {
    return "";
  }
  switch (typeof value) {
    case "string":
      return value;
    case "number":
    case "boolean":
    case "bigint":
      return String(value);
    default:
      throw syntaxError(
        `Value '${path}' cannot be rendered as scalar text (received ${typeof value})`,
        location,
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

function renderNodes(nodes: Node[], context: RenderContext): string {
  let output = "";

  for (const node of nodes) {
    if (node.kind === "text") {
      output += node.value;
      continue;
    }

    if (node.kind === "value") {
      const text = scalar(resolve(node.path, context), node.path, node.location);
      output += node.escaped ? escapeHtml(text) : text;
      continue;
    }

    const value = resolve(node.path, context);
    if (node.blockType === "if") {
      output += renderNodes(isTruthy(value) ? node.truthy : node.falsy, context);
      continue;
    }

    if (!Array.isArray(value) || value.length === 0) {
      output += renderNodes(node.falsy, context);
      continue;
    }

    for (let index = 0; index < value.length; index += 1) {
      context.frames.push({ value: value[index], index });
      try {
        output += renderNodes(node.truthy, context);
      } finally {
        context.frames.pop();
      }
    }
  }

  return output;
}

/** Render a Mini Template string using the supplied root data value. */
export function render(template: string, data: unknown): string {
  return renderNodes(parse(template), { root: data, frames: [] });
}
