type SourceLocation = {
  line: number;
  column: number;
};

type TextNode = {
  type: "text";
  value: string;
};

type InterpolationNode = {
  type: "interpolation";
  path: string;
  escaped: boolean;
  location: SourceLocation;
};

type BlockNode = {
  type: "if" | "each";
  path: string;
  body: Node[];
  alternate: Node[];
  location: SourceLocation;
};

type Node = TextNode | InterpolationNode | BlockNode;

type BlockFrame = {
  node: BlockNode;
  inAlternate: boolean;
};

type RenderContext = {
  value: unknown;
  index?: number;
};

const MISSING = Symbol("missing");

function locationAt(template: string, offset: number): SourceLocation {
  let line = 1;
  let column = 1;

  for (let i = 0; i < offset; i += 1) {
    if (template.charCodeAt(i) === 10) {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }

  return { line, column };
}

function templateError(message: string, location: SourceLocation): Error {
  return new Error(`${message} at line ${location.line}, column ${location.column}`);
}

function parse(template: string): Node[] {
  const root: Node[] = [];
  const stack: BlockFrame[] = [];
  let output = root;
  let cursor = 0;

  while (cursor < template.length) {
    const open = template.indexOf("{{", cursor);
    if (open === -1) {
      output.push({ type: "text", value: template.slice(cursor) });
      break;
    }

    if (open > cursor) {
      output.push({ type: "text", value: template.slice(cursor, open) });
    }

    const location = locationAt(template, open);
    const triple = template.startsWith("{{{", open);
    const closeToken = triple ? "}}}" : "}}";
    const contentStart = open + (triple ? 3 : 2);
    const close = template.indexOf(closeToken, contentStart);

    if (close === -1) {
      throw templateError("Unclosed template tag", location);
    }

    const tag = template.slice(contentStart, close).trim();
    cursor = close + closeToken.length;

    if (triple) {
      output.push({ type: "interpolation", path: tag, escaped: false, location });
      continue;
    }

    if (tag.startsWith("!")) {
      continue;
    }

    if (tag === "else") {
      const frame = stack.at(-1);
      if (frame === undefined) {
        throw templateError("'else' used outside a block", location);
      }
      if (frame.inAlternate) {
        throw templateError("Duplicate 'else' in block", location);
      }

      frame.inAlternate = true;
      output = frame.node.alternate;
      continue;
    }

    if (tag.startsWith("#")) {
      const match = /^#(if|each)(?:\s+(.+))$/.exec(tag);
      if (match === null) {
        const name = tag.slice(1).split(/\s/, 1)[0] || "(empty)";
        if (name === "if" || name === "each") {
          throw templateError(`Block '${name}' requires a path`, location);
        }
        throw templateError(`Unknown block '${name}'`, location);
      }

      const node: BlockNode = {
        type: match[1] as "if" | "each",
        path: match[2].trim(),
        body: [],
        alternate: [],
        location,
      };
      output.push(node);
      stack.push({ node, inAlternate: false });
      output = node.body;
      continue;
    }

    if (tag.startsWith("/")) {
      const name = tag.slice(1).trim();
      if (name !== "if" && name !== "each") {
        throw templateError(`Unknown closing block '${name || "(empty)"}'`, location);
      }

      const frame = stack.at(-1);
      if (frame === undefined) {
        throw templateError(`Closing block '${name}' has no opener`, location);
      }
      if (frame.node.type !== name) {
        throw templateError(
          `Mismatched closing block: expected '/${frame.node.type}' but found '/${name}'`,
          location,
        );
      }

      stack.pop();
      const parent = stack.at(-1);
      output = parent === undefined
        ? root
        : parent.inAlternate
          ? parent.node.alternate
          : parent.node.body;
      continue;
    }

    output.push({ type: "interpolation", path: tag, escaped: true, location });
  }

  const unclosed = stack.at(-1);
  if (unclosed !== undefined) {
    throw templateError(`Unclosed '${unclosed.node.type}' block`, unclosed.node.location);
  }

  return root;
}

function getPath(value: unknown, path: string): unknown | typeof MISSING {
  if (path === "") {
    return MISSING;
  }

  let current = value;
  for (const part of path.split(".")) {
    if (
      current === null
      || current === undefined
      || (typeof current !== "object" && typeof current !== "function")
      || !Object.prototype.hasOwnProperty.call(current, part)
    ) {
      return MISSING;
    }
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

function resolvePath(path: string, contexts: RenderContext[], root: unknown): unknown | typeof MISSING {
  const current = contexts.at(-1);

  if (path === "this") {
    return current === undefined ? root : current.value;
  }
  if (path.startsWith("this.")) {
    return getPath(current === undefined ? root : current.value, path.slice(5));
  }
  if (path === "@index") {
    return current?.index ?? MISSING;
  }

  if (current !== undefined && contexts.length > 1) {
    const local = getPath(current.value, path);
    if (local !== MISSING) {
      return local;
    }
  }

  return getPath(root, path);
}

function isTruthy(value: unknown | typeof MISSING): boolean {
  if (value === MISSING || value === null || value === undefined || value === false) {
    return false;
  }
  if (value === "" || value === 0 || value === 0n) {
    return false;
  }
  if (Array.isArray(value) && value.length === 0) {
    return false;
  }
  return true;
}

function scalarToString(value: unknown | typeof MISSING, node: InterpolationNode): string {
  if (value === MISSING || value === null || value === undefined) {
    return "";
  }

  switch (typeof value) {
    case "string":
    case "number":
    case "bigint":
    case "boolean":
    case "symbol":
      return String(value);
    default:
      throw templateError(
        `Cannot render non-scalar value at '${node.path || "(empty path)"}'`,
        node.location,
      );
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      default: return "&#39;";
    }
  });
}

function renderNodes(nodes: Node[], contexts: RenderContext[], root: unknown): string {
  let result = "";

  for (const node of nodes) {
    if (node.type === "text") {
      result += node.value;
      continue;
    }

    const value = resolvePath(node.path, contexts, root);
    if (node.type === "interpolation") {
      const text = scalarToString(value, node);
      result += node.escaped ? escapeHtml(text) : text;
      continue;
    }

    if (node.type === "if") {
      result += renderNodes(isTruthy(value) ? node.body : node.alternate, contexts, root);
      continue;
    }

    if (Array.isArray(value) && value.length > 0) {
      for (let index = 0; index < value.length; index += 1) {
        result += renderNodes(node.body, [...contexts, { value: value[index], index }], root);
      }
    } else {
      result += renderNodes(node.alternate, contexts, root);
    }
  }

  return result;
}

/** Render a Mini Template string with the supplied data. */
export function render(template: string, data: unknown): string {
  const nodes = parse(template);
  return renderNodes(nodes, [{ value: data }], data);
}
