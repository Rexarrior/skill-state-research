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
      truthy: Node[];
      falsy: Node[];
      location: Location;
    };

type BlockNode = Extract<Node, { type: "block" }>;

type Frame = {
  block: BlockNode;
  children: Node[];
  hasElse: boolean;
};

type Scope = {
  value: unknown;
  index: number;
};

const MISSING = Symbol("missing");

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

function parse(template: string): Node[] {
  const root: Node[] = [];
  const stack: Frame[] = [];
  let children = root;
  let cursor = 0;

  while (cursor < template.length) {
    const opening = template.indexOf("{{", cursor);
    if (opening === -1) {
      children.push({ type: "text", value: template.slice(cursor) });
      break;
    }

    if (opening > cursor) {
      children.push({ type: "text", value: template.slice(cursor, opening) });
    }

    const triple = template.startsWith("{{{", opening);
    const closingText = triple ? "}}}" : "}}";
    const contentStart = opening + (triple ? 3 : 2);
    const closing = template.indexOf(closingText, contentStart);
    const location = locationAt(template, opening);

    if (closing === -1) {
      throw syntaxError("Unclosed tag", location);
    }

    const tag = template.slice(contentStart, closing).trim();
    cursor = closing + closingText.length;

    if (triple) {
      if (!tag) throw syntaxError("Empty interpolation", location);
      children.push({ type: "value", path: tag, escaped: false, location });
      continue;
    }

    if (tag.startsWith("!")) continue;

    if (tag.startsWith("#")) {
      const match = /^#(if|each)\s+(.+)$/.exec(tag);
      if (!match) {
        const name = tag.slice(1).trim().split(/\s+/, 1)[0] || "(empty)";
        throw syntaxError(`Unknown or malformed block '${name}'`, location);
      }

      const block: BlockNode = {
        type: "block",
        kind: match[1] as "if" | "each",
        path: match[2].trim(),
        truthy: [],
        falsy: [],
        location,
      };
      children.push(block);
      const frame = { block, children: block.truthy, hasElse: false };
      stack.push(frame);
      children = frame.children;
      continue;
    }

    if (tag === "else") {
      const frame = stack.at(-1);
      if (!frame) throw syntaxError("'else' outside a block", location);
      if (frame.hasElse) throw syntaxError("Duplicate 'else'", location);
      frame.hasElse = true;
      frame.children = frame.block.falsy;
      children = frame.children;
      continue;
    }

    if (tag.startsWith("/")) {
      const name = tag.slice(1).trim();
      const frame = stack.at(-1);
      if (!frame) throw syntaxError(`Closing '${name}' without an open block`, location);
      if (name !== frame.block.kind) {
        throw syntaxError(
          `Mismatched closing block: expected '/${frame.block.kind}', got '/${name}'`,
          location,
        );
      }
      stack.pop();
      children = stack.at(-1)?.children ?? root;
      continue;
    }

    if (!tag) throw syntaxError("Empty interpolation", location);
    children.push({ type: "value", path: tag, escaped: true, location });
  }

  const unclosed = stack.at(-1)?.block;
  if (unclosed) {
    throw syntaxError(`Unclosed '${unclosed.kind}' block`, unclosed.location);
  }

  return root;
}

function property(value: unknown, parts: string[]): unknown | typeof MISSING {
  let current = value;
  for (const part of parts) {
    if ((typeof current !== "object" || current === null) && typeof current !== "function") {
      return MISSING;
    }
    if (!Object.prototype.hasOwnProperty.call(current, part)) return MISSING;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function resolve(path: string, root: unknown, scopes: Scope[]): unknown | typeof MISSING {
  const parts = path.split(".");
  const scope = scopes.at(-1);

  if (parts[0] === "this") {
    if (!scope) return MISSING;
    return property(scope.value, parts.slice(1));
  }
  if (parts[0] === "@index") {
    if (!scope || parts.length !== 1) return MISSING;
    return scope.index;
  }

  if (scope) {
    const local = property(scope.value, parts);
    if (local !== MISSING) return local;
  }
  return property(root, parts);
}

function isTruthy(value: unknown | typeof MISSING): boolean {
  if (value === MISSING || value === null || value === undefined || value === false) return false;
  if (value === "" || value === 0 || value === 0n) return false;
  if (Array.isArray(value) && value.length === 0) return false;
  return true;
}

function scalar(value: unknown | typeof MISSING, path: string, location: Location): string {
  if (value === MISSING || value === null || value === undefined) return "";
  if (typeof value === "object" || typeof value === "function") {
    throw syntaxError(`Cannot render non-scalar value at '${path}'`, location);
  }
  return String(value);
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

function renderNodes(nodes: Node[], root: unknown, scopes: Scope[]): string {
  let output = "";

  for (const node of nodes) {
    if (node.type === "text") {
      output += node.value;
      continue;
    }

    if (node.type === "value") {
      const text = scalar(resolve(node.path, root, scopes), node.path, node.location);
      output += node.escaped ? escapeHtml(text) : text;
      continue;
    }

    const value = resolve(node.path, root, scopes);
    if (node.kind === "if") {
      output += renderNodes(isTruthy(value) ? node.truthy : node.falsy, root, scopes);
    } else if (Array.isArray(value) && value.length > 0) {
      for (let index = 0; index < value.length; index++) {
        output += renderNodes(node.truthy, root, [...scopes, { value: value[index], index }]);
      }
    } else {
      output += renderNodes(node.falsy, root, scopes);
    }
  }

  return output;
}

export function render(template: string, data: unknown): string {
  return renderNodes(parse(template), data, []);
}
