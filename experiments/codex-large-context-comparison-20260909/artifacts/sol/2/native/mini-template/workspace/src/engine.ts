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
  parent: Node[];
  inAlternate: boolean;
};

type EachContext = {
  value: unknown;
  index: number;
};

type Resolution =
  | { found: true; value: unknown }
  | { found: false; value: undefined };

const PATH_PATTERN = /^(?:this|@index|[^.\s{}]+)(?:\.[^.\s{}]+)*$/;

function locationAt(source: string, offset: number): SourceLocation {
  let line = 1;
  let column = 1;

  for (let i = 0; i < offset; i += 1) {
    if (source.charCodeAt(i) === 10) {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }

  return { line, column };
}

function syntaxError(message: string, location: SourceLocation): Error {
  return new Error(`${message} at line ${location.line}, column ${location.column}`);
}

function assertPath(path: string, location: SourceLocation): void {
  if (!PATH_PATTERN.test(path)) {
    throw syntaxError(`Invalid path ${JSON.stringify(path)}`, location);
  }
}

function parse(template: string): Node[] {
  const root: Node[] = [];
  const stack: BlockFrame[] = [];
  let current = root;
  let offset = 0;

  while (offset < template.length) {
    const opening = template.indexOf("{{", offset);
    if (opening === -1) {
      current.push({ type: "text", value: template.slice(offset) });
      break;
    }

    if (opening > offset) {
      current.push({ type: "text", value: template.slice(offset, opening) });
    }

    const location = locationAt(template, opening);
    const triple = template.startsWith("{{{", opening);
    const closingText = triple ? "}}}" : "}}";
    const contentStart = opening + (triple ? 3 : 2);
    const closing = template.indexOf(closingText, contentStart);

    if (closing === -1) {
      throw syntaxError(`Unclosed ${triple ? "triple interpolation" : "tag"}`, location);
    }

    const content = template.slice(contentStart, closing).trim();
    offset = closing + closingText.length;

    if (triple) {
      assertPath(content, location);
      current.push({
        type: "interpolation",
        path: content,
        escaped: false,
        location,
      });
      continue;
    }

    if (content.startsWith("!")) {
      continue;
    }

    if (content === "else") {
      const frame = stack.at(-1);
      if (!frame) {
        throw syntaxError("Unexpected else outside a block", location);
      }
      if (frame.inAlternate) {
        throw syntaxError("Duplicate else", location);
      }
      frame.inAlternate = true;
      current = frame.node.alternate;
      continue;
    }

    if (content.startsWith("#")) {
      const match = /^#([^\s]+)(?:\s+(.+))?$/.exec(content);
      const blockName = match?.[1] ?? content.slice(1);
      if (blockName !== "if" && blockName !== "each") {
        throw syntaxError(`Unknown block ${JSON.stringify(blockName)}`, location);
      }

      const path = match?.[2]?.trim() ?? "";
      assertPath(path, location);
      const node: BlockNode = {
        type: blockName,
        path,
        body: [],
        alternate: [],
        location,
      };
      current.push(node);
      stack.push({ node, parent: current, inAlternate: false });
      current = node.body;
      continue;
    }

    if (content.startsWith("/")) {
      const closeName = content.slice(1).trim();
      if (closeName !== "if" && closeName !== "each") {
        throw syntaxError(`Unknown closing block ${JSON.stringify(closeName)}`, location);
      }

      const frame = stack.at(-1);
      if (!frame) {
        throw syntaxError(`Unexpected closing block ${JSON.stringify(closeName)}`, location);
      }
      if (frame.node.type !== closeName) {
        throw syntaxError(
          `Mismatched closing block ${JSON.stringify(closeName)}; expected ${JSON.stringify(frame.node.type)}`,
          location,
        );
      }

      stack.pop();
      current = frame.parent;
      continue;
    }

    assertPath(content, location);
    current.push({
      type: "interpolation",
      path: content,
      escaped: true,
      location,
    });
  }

  const unclosed = stack.at(-1)?.node;
  if (unclosed) {
    throw syntaxError(`Unclosed ${JSON.stringify(`#${unclosed.type}`)} block`, unclosed.location);
  }

  return root;
}

function ownProperty(value: unknown, key: string): Resolution {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") {
    return { found: false, value: undefined };
  }
  if (!Object.prototype.hasOwnProperty.call(value, key)) {
    return { found: false, value: undefined };
  }
  return { found: true, value: (value as Record<string, unknown>)[key] };
}

function walk(value: unknown, parts: string[]): Resolution {
  let current = value;
  for (const part of parts) {
    const next = ownProperty(current, part);
    if (!next.found) return next;
    current = next.value;
  }
  return { found: true, value: current };
}

function resolve(path: string, root: unknown, contexts: EachContext[]): unknown {
  const parts = path.split(".");
  const context = contexts.at(-1);

  if (parts[0] === "this") {
    return context ? walk(context.value, parts.slice(1)).value : undefined;
  }
  if (parts[0] === "@index") {
    return context && parts.length === 1 ? context.index : undefined;
  }

  if (context) {
    const local = walk(context.value, parts);
    if (local.found) return local.value;
  }
  return walk(root, parts).value;
}

function isTruthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return value !== "" && value !== 0 && value !== false && value != null;
}

function scalarText(value: unknown, path: string, location: SourceLocation): string {
  if (value == null) return "";

  switch (typeof value) {
    case "string":
    case "number":
    case "bigint":
    case "boolean":
      return String(value);
    default:
      throw syntaxError(
        `Cannot render ${typeof value === "object" ? "an object" : `a ${typeof value}`} at path ${JSON.stringify(path)}`,
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

function renderNodes(nodes: Node[], root: unknown, contexts: EachContext[]): string {
  let output = "";

  for (const node of nodes) {
    if (node.type === "text") {
      output += node.value;
      continue;
    }

    const value = resolve(node.path, root, contexts);
    if (node.type === "interpolation") {
      const text = scalarText(value, node.path, node.location);
      output += node.escaped ? escapeHtml(text) : text;
      continue;
    }

    if (node.type === "if") {
      output += renderNodes(isTruthy(value) ? node.body : node.alternate, root, contexts);
      continue;
    }

    if (Array.isArray(value) && value.length > 0) {
      for (let index = 0; index < value.length; index += 1) {
        output += renderNodes(node.body, root, [
          ...contexts,
          { value: value[index], index },
        ]);
      }
    } else {
      output += renderNodes(node.alternate, root, contexts);
    }
  }

  return output;
}

/** Render a Mini Template string with values from data. */
export function render(template: string, data: unknown): string {
  return renderNodes(parse(template), data, []);
}
