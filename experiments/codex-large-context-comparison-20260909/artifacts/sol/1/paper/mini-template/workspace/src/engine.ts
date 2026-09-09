type Location = {
  line: number;
  column: number;
};

type Node =
  | { type: "text"; value: string }
  | { type: "value"; path: string; escaped: boolean; location: Location }
  | {
      type: "block";
      kind: "if" | "each";
      path: string;
      body: Node[];
      alternate: Node[];
      location: Location;
    };

type BlockNode = Extract<Node, { type: "block" }>;

type Frame = {
  block: BlockNode | null;
  nodes: Node[];
  inAlternate: boolean;
};

type LoopContext = {
  value: unknown;
  index: number;
};

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

function requirePath(path: string, construct: string, location: Location): string {
  if (path.length === 0) {
    throw syntaxError(`${construct} requires a path`, location);
  }
  return path;
}

function parse(template: string): Node[] {
  const root: Node[] = [];
  const stack: Frame[] = [{ block: null, nodes: root, inAlternate: false }];
  let cursor = 0;

  const currentNodes = (): Node[] => stack[stack.length - 1]!.nodes;

  while (cursor < template.length) {
    const tagStart = template.indexOf("{{", cursor);
    if (tagStart === -1) {
      currentNodes().push({ type: "text", value: template.slice(cursor) });
      cursor = template.length;
      break;
    }

    if (tagStart > cursor) {
      currentNodes().push({ type: "text", value: template.slice(cursor, tagStart) });
    }

    const triple = template.startsWith("{{{", tagStart);
    const closing = triple ? "}}}" : "}}";
    const contentStart = tagStart + (triple ? 3 : 2);
    const tagEnd = template.indexOf(closing, contentStart);
    const location = locationAt(template, tagStart);

    if (tagEnd === -1) {
      throw syntaxError("Unclosed tag", location);
    }

    const content = template.slice(contentStart, tagEnd).trim();
    cursor = tagEnd + closing.length;

    if (triple) {
      currentNodes().push({
        type: "value",
        path: requirePath(content, "Interpolation", location),
        escaped: false,
        location,
      });
      continue;
    }

    if (content.startsWith("!")) {
      continue;
    }

    if (content === "else") {
      const frame = stack[stack.length - 1]!;
      if (frame.block === null) {
        throw syntaxError("'else' outside a block", location);
      }
      if (frame.inAlternate) {
        throw syntaxError("Duplicate 'else'", location);
      }
      frame.inAlternate = true;
      frame.nodes = frame.block.alternate;
      continue;
    }

    if (content.startsWith("#")) {
      const match = /^#(\S+)(?:\s+([\s\S]*?))?$/.exec(content);
      const name = match?.[1] ?? "";
      const path = (match?.[2] ?? "").trim();
      if (name !== "if" && name !== "each") {
        throw syntaxError(`Unknown block '${name || content}'`, location);
      }

      const block: BlockNode = {
        type: "block",
        kind: name,
        path: requirePath(path, `#${name}`, location),
        body: [],
        alternate: [],
        location,
      };
      currentNodes().push(block);
      stack.push({ block, nodes: block.body, inAlternate: false });
      continue;
    }

    if (content.startsWith("/")) {
      const name = content.slice(1).trim();
      const frame = stack[stack.length - 1]!;
      if (frame.block === null) {
        throw syntaxError(`Closing '${name}' without an open block`, location);
      }
      if (name !== frame.block.kind) {
        throw syntaxError(
          `Mismatched closing block: expected '/${frame.block.kind}' but found '/${name}'`,
          location,
        );
      }
      stack.pop();
      continue;
    }

    currentNodes().push({
      type: "value",
      path: requirePath(content, "Interpolation", location),
      escaped: true,
      location,
    });
  }

  if (stack.length > 1) {
    const block = stack[stack.length - 1]!.block!;
    throw syntaxError(`Unclosed '#${block.kind}' block`, block.location);
  }

  return root;
}

function property(value: unknown, key: string): unknown {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") {
    return undefined;
  }
  return Object.prototype.hasOwnProperty.call(value, key)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function descend(value: unknown, parts: string[]): unknown {
  let current = value;
  for (const part of parts) {
    if (part.length === 0) return undefined;
    current = property(current, part);
    if (current === undefined) return undefined;
  }
  return current;
}

function resolve(path: string, root: unknown, loops: LoopContext[]): unknown {
  const parts = path.split(".");
  const currentLoop = loops[loops.length - 1];

  if (parts[0] === "this") {
    if (!currentLoop) return undefined;
    return descend(currentLoop.value, parts.slice(1));
  }

  if (parts[0] === "@index") {
    if (!currentLoop) return undefined;
    return parts.length === 1 ? currentLoop.index : undefined;
  }

  return descend(root, parts);
}

function isTruthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return value !== "" && value !== 0 && value !== false && value !== null && value !== undefined;
}

function scalarText(value: unknown, path: string, location: Location): string {
  if (value === null || value === undefined) return "";
  switch (typeof value) {
    case "string":
    case "number":
    case "bigint":
    case "boolean":
      return String(value);
    default:
      throw syntaxError(`Value at '${path}' is not scalar and cannot be rendered`, location);
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

function renderNodes(nodes: Node[], root: unknown, loops: LoopContext[]): string {
  let output = "";

  for (const node of nodes) {
    if (node.type === "text") {
      output += node.value;
      continue;
    }

    if (node.type === "value") {
      const text = scalarText(resolve(node.path, root, loops), node.path, node.location);
      output += node.escaped ? escapeHtml(text) : text;
      continue;
    }

    const value = resolve(node.path, root, loops);
    if (node.kind === "if") {
      output += renderNodes(isTruthy(value) ? node.body : node.alternate, root, loops);
      continue;
    }

    if (!Array.isArray(value) || value.length === 0) {
      output += renderNodes(node.alternate, root, loops);
      continue;
    }

    for (let index = 0; index < value.length; index += 1) {
      loops.push({ value: value[index], index });
      output += renderNodes(node.body, root, loops);
      loops.pop();
    }
  }

  return output;
}

/** Render a Mini Template string with values from data. */
export function render(template: string, data: unknown): string {
  return renderNodes(parse(template), data, []);
}
