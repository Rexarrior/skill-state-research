type Location = {
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
  location: Location;
};

type BlockNode = {
  type: "if" | "each";
  path: string;
  body: Node[];
  alternate: Node[];
  location: Location;
};

type Node = TextNode | InterpolationNode | BlockNode;

type Frame = {
  block: BlockNode;
  parent: Node[];
  inAlternate: boolean;
};

type Context = {
  root: unknown;
  current: unknown;
  index: number | undefined;
};

// A path segment is deliberately permissive because JSON object keys may begin
// with digits or contain punctuation. Dots remain the path separator.
const PATH_PART = /^[^\s.{}]+$/;

function templateError(message: string, location: Location): Error {
  return new Error(
    `Template error at line ${location.line}, column ${location.column}: ${message}`,
  );
}

function advanceLocation(text: string, location: Location): void {
  for (const character of text) {
    if (character === "\n") {
      location.line += 1;
      location.column = 1;
    } else {
      location.column += 1;
    }
  }
}

function validatePath(path: string, location: Location): void {
  if (path === "this" || path === "@index") return;

  let normalPath = path;
  if (normalPath.startsWith("this.")) {
    normalPath = normalPath.slice(5);
  }

  if (
    normalPath.length === 0 ||
    normalPath.split(".").some((part) => !PATH_PART.test(part))
  ) {
    throw templateError(`Invalid path "${path}"`, location);
  }
}

function parse(template: string): Node[] {
  const root: Node[] = [];
  const stack: Frame[] = [];
  let destination = root;
  let offset = 0;
  const location: Location = { line: 1, column: 1 };

  while (offset < template.length) {
    const open = template.indexOf("{{", offset);
    if (open === -1) {
      destination.push({ type: "text", value: template.slice(offset) });
      break;
    }

    if (open > offset) {
      const text = template.slice(offset, open);
      destination.push({ type: "text", value: text });
      advanceLocation(text, location);
      offset = open;
    }

    const tagLocation = { ...location };
    const triple = template.startsWith("{{{", offset);
    const closing = triple ? "}}}" : "}}";
    const contentStart = offset + (triple ? 3 : 2);
    const close = template.indexOf(closing, contentStart);

    if (close === -1) {
      throw templateError("Unclosed tag", tagLocation);
    }

    const completeTag = template.slice(offset, close + closing.length);
    const content = template.slice(contentStart, close).trim();

    if (triple) {
      validatePath(content, tagLocation);
      destination.push({
        type: "interpolation",
        path: content,
        escaped: false,
        location: tagLocation,
      });
    } else if (content.startsWith("!")) {
      // Comments deliberately emit no node.
    } else if (content.startsWith("#")) {
      const declaration = content.slice(1).trim();
      const separator = declaration.search(/\s/);
      const kind = separator === -1 ? declaration : declaration.slice(0, separator);
      const path = separator === -1 ? "" : declaration.slice(separator).trim();

      if (kind !== "if" && kind !== "each") {
        throw templateError(`Unknown block "${kind || declaration}"`, tagLocation);
      }
      validatePath(path, tagLocation);

      const block: BlockNode = {
        type: kind,
        path,
        body: [],
        alternate: [],
        location: tagLocation,
      };
      destination.push(block);
      stack.push({ block, parent: destination, inAlternate: false });
      destination = block.body;
    } else if (content === "else") {
      const frame = stack.at(-1);
      if (!frame) {
        throw templateError("Unexpected else outside a block", tagLocation);
      }
      if (frame.inAlternate) {
        throw templateError("Duplicate else in block", tagLocation);
      }
      frame.inAlternate = true;
      destination = frame.block.alternate;
    } else if (content.startsWith("/")) {
      const kind = content.slice(1).trim();
      const frame = stack.at(-1);
      if (!frame) {
        throw templateError(`Unexpected closing block "${kind}"`, tagLocation);
      }
      if (kind !== frame.block.type) {
        throw templateError(
          `Mismatched closing block: expected /${frame.block.type}, got /${kind}`,
          tagLocation,
        );
      }
      stack.pop();
      destination = frame.parent;
    } else {
      validatePath(content, tagLocation);
      destination.push({
        type: "interpolation",
        path: content,
        escaped: true,
        location: tagLocation,
      });
    }

    advanceLocation(completeTag, location);
    offset = close + closing.length;
  }

  const unclosed = stack.at(-1)?.block;
  if (unclosed) {
    throw templateError(`Unclosed ${unclosed.type} block`, unclosed.location);
  }

  return root;
}

function readPath(value: unknown, parts: string[]): { found: boolean; value: unknown } {
  let cursor = value;
  for (const part of parts) {
    if (
      (typeof cursor !== "object" || cursor === null) &&
      typeof cursor !== "function"
    ) {
      return { found: false, value: undefined };
    }
    if (!Object.prototype.hasOwnProperty.call(cursor, part)) {
      return { found: false, value: undefined };
    }
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return { found: true, value: cursor };
}

function resolve(path: string, context: Context): unknown {
  if (path === "this") return context.current;
  if (path === "@index") return context.index;

  if (path.startsWith("this.")) {
    return readPath(context.current, path.slice(5).split(".")).value;
  }

  const parts = path.split(".");
  const local = readPath(context.current, parts);
  if (local.found) return local.value;
  return readPath(context.root, parts).value;
}

function isTruthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return !(
    value === "" ||
    value === 0 ||
    value === 0n ||
    value === false ||
    value === null ||
    value === undefined
  );
}

function scalarText(value: unknown, path: string, location: Location): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object" || typeof value === "function") {
    throw templateError(
      `Value at "${path}" cannot be rendered as scalar text`,
      location,
    );
  }
  return String(value);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function renderNodes(nodes: Node[], context: Context): string {
  let result = "";

  for (const node of nodes) {
    if (node.type === "text") {
      result += node.value;
      continue;
    }

    if (node.type === "interpolation") {
      const text = scalarText(resolve(node.path, context), node.path, node.location);
      result += node.escaped ? escapeHtml(text) : text;
      continue;
    }

    const value = resolve(node.path, context);
    if (node.type === "if") {
      result += renderNodes(isTruthy(value) ? node.body : node.alternate, context);
      continue;
    }

    if (Array.isArray(value) && value.length > 0) {
      for (let index = 0; index < value.length; index += 1) {
        result += renderNodes(node.body, {
          root: context.root,
          current: value[index],
          index,
        });
      }
    } else {
      result += renderNodes(node.alternate, context);
    }
  }

  return result;
}

/** Render a Mini Template string using values from data. */
export function render(template: string, data: unknown): string {
  const nodes = parse(template);
  return renderNodes(nodes, { root: data, current: data, index: undefined });
}
