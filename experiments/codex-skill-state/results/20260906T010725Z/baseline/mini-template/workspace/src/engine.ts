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
  truthy: Node[];
  fallback: Node[];
  location: Location;
};

type Node = TextNode | InterpolationNode | BlockNode;

type Frame = {
  block: BlockNode | null;
  nodes: Node[];
  inElse: boolean;
};

type RenderContext = {
  root: unknown;
  current: unknown;
  index: number | undefined;
};

const MISSING = Symbol("missing");

/** Render a Mini Template string with the supplied data. */
export function render(template: string, data: unknown): string {
  const nodes = parse(template);
  return renderNodes(nodes, { root: data, current: data, index: undefined });
}

function parse(template: string): Node[] {
  const root: Node[] = [];
  const stack: Frame[] = [{ block: null, nodes: root, inElse: false }];
  let cursor = 0;

  while (cursor < template.length) {
    const opening = template.indexOf("{{", cursor);
    if (opening === -1) {
      stack[stack.length - 1].nodes.push({ type: "text", value: template.slice(cursor) });
      break;
    }

    if (opening > cursor) {
      stack[stack.length - 1].nodes.push({
        type: "text",
        value: template.slice(cursor, opening),
      });
    }

    const location = locate(template, opening);
    const triple = template.startsWith("{{{", opening);
    const closingText = triple ? "}}}" : "}}";
    const contentStart = opening + (triple ? 3 : 2);
    const closing = template.indexOf(closingText, contentStart);

    if (closing === -1) {
      throw syntaxError("Unclosed tag", location);
    }

    const raw = template.slice(contentStart, closing);
    const tag = raw.trim();
    cursor = closing + closingText.length;

    if (triple) {
      addInterpolation(stack, tag, false, location);
      continue;
    }

    if (tag.startsWith("!")) {
      continue;
    }

    if (tag === "else") {
      const frame = stack[stack.length - 1];
      if (frame.block === null) {
        throw syntaxError("'else' outside a block", location);
      }
      if (frame.inElse) {
        throw syntaxError("Duplicate 'else'", location);
      }
      frame.inElse = true;
      frame.nodes = frame.block.fallback;
      continue;
    }

    if (tag.startsWith("#")) {
      const match = /^#(if|each)(?:\s+(.+))?$/.exec(tag);
      if (!match) {
        const name = tag.slice(1).split(/\s/, 1)[0] || tag;
        throw syntaxError(`Unknown or malformed block '${name}'`, location);
      }
      const path = match[2]?.trim() ?? "";
      validatePath(path, location);
      const block: BlockNode = {
        type: match[1] as "if" | "each",
        path,
        truthy: [],
        fallback: [],
        location,
      };
      stack[stack.length - 1].nodes.push(block);
      stack.push({ block, nodes: block.truthy, inElse: false });
      continue;
    }

    if (tag.startsWith("/")) {
      const name = tag.slice(1).trim();
      if (name !== "if" && name !== "each") {
        throw syntaxError(`Unknown closing block '${name}'`, location);
      }
      const frame = stack[stack.length - 1];
      if (frame.block === null) {
        throw syntaxError(`Closing '${name}' without an open block`, location);
      }
      if (frame.block.type !== name) {
        throw syntaxError(
          `Mismatched closing block: expected '/${frame.block.type}', found '/${name}'`,
          location,
        );
      }
      stack.pop();
      continue;
    }

    addInterpolation(stack, tag, true, location);
  }

  const openFrame = stack[stack.length - 1];
  if (openFrame.block !== null) {
    throw syntaxError(`Unclosed '${openFrame.block.type}' block`, openFrame.block.location);
  }

  return root;
}

function addInterpolation(
  stack: Frame[],
  path: string,
  escaped: boolean,
  location: Location,
): void {
  validatePath(path, location);
  stack[stack.length - 1].nodes.push({
    type: "interpolation",
    path,
    escaped,
    location,
  });
}

function validatePath(path: string, location: Location): void {
  const parts = path.split(".");
  if (
    path.length === 0 ||
    /\s/.test(path) ||
    parts.some((part) => part.length === 0) ||
    (path.startsWith("@") && path !== "@index")
  ) {
    throw syntaxError(`Invalid path '${path}'`, location);
  }
}

function renderNodes(nodes: Node[], context: RenderContext): string {
  let output = "";

  for (const node of nodes) {
    if (node.type === "text") {
      output += node.value;
      continue;
    }

    if (node.type === "interpolation") {
      const value = resolve(node.path, context);
      const text = scalarToString(value, node.path, node.location);
      output += node.escaped ? escapeHtml(text) : text;
      continue;
    }

    const value = resolve(node.path, context);
    if (node.type === "if") {
      output += renderNodes(isTruthy(value) ? node.truthy : node.fallback, context);
      continue;
    }

    if (Array.isArray(value) && value.length > 0) {
      for (let index = 0; index < value.length; index += 1) {
        output += renderNodes(node.truthy, {
          root: context.root,
          current: value[index],
          index,
        });
      }
    } else {
      output += renderNodes(node.fallback, context);
    }
  }

  return output;
}

function resolve(path: string, context: RenderContext): unknown | typeof MISSING {
  if (path === "@index") {
    return context.index === undefined ? MISSING : context.index;
  }

  if (path === "this") {
    return context.current;
  }

  if (path.startsWith("this.")) {
    return readPath(context.current, path.slice(5).split("."));
  }

  const parts = path.split(".");
  const local = readPath(context.current, parts);
  return local === MISSING ? readPath(context.root, parts) : local;
}

function readPath(value: unknown, parts: string[]): unknown | typeof MISSING {
  let current = value;
  for (const part of parts) {
    if ((typeof current !== "object" || current === null) && typeof current !== "function") {
      return MISSING;
    }
    if (!Object.prototype.hasOwnProperty.call(current, part)) {
      return MISSING;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function isTruthy(value: unknown | typeof MISSING): boolean {
  if (value === MISSING || value === null || value === undefined || value === false) {
    return false;
  }
  if (value === "" || value === 0) {
    return false;
  }
  if (Array.isArray(value) && value.length === 0) {
    return false;
  }
  return true;
}

function scalarToString(
  value: unknown | typeof MISSING,
  path: string,
  location: Location,
): string {
  if (value === MISSING || value === null || value === undefined) {
    return "";
  }
  if (typeof value === "object" || typeof value === "function") {
    throw new Error(
      `Cannot render non-scalar value at '${path}' (${formatLocation(location)})`,
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

function locate(template: string, offset: number): Location {
  const before = template.slice(0, offset);
  const lines = before.split("\n");
  return { line: lines.length, column: lines[lines.length - 1].length + 1 };
}

function formatLocation(location: Location): string {
  return `line ${location.line}, column ${location.column}`;
}

function syntaxError(message: string, location: Location): Error {
  return new Error(`${message} (${formatLocation(location)})`);
}
