type SourcePosition = {
  line: number;
  column: number;
};

type Node =
  | { kind: "text"; value: string }
  | { kind: "value"; path: string; escaped: boolean; position: SourcePosition }
  | {
      kind: "if" | "each";
      path: string;
      body: Node[];
      alternate: Node[];
      position: SourcePosition;
    };

type BlockNode = Extract<Node, { kind: "if" | "each" }>;

type Frame = {
  node: BlockNode;
  parent: Node[];
  inAlternate: boolean;
};

type LoopContext = {
  value: unknown;
  index: number;
};

const MISSING = Symbol("missing template value");

function positionAt(source: string, offset: number): SourcePosition {
  let line = 1;
  let column = 1;

  for (let i = 0; i < offset; i += 1) {
    if (source[i] === "\n") {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }

  return { line, column };
}

function syntaxError(message: string, position: SourcePosition): Error {
  return new Error(`${message} at line ${position.line}, column ${position.column}`);
}

function requirePath(
  tag: string,
  directive: string,
  position: SourcePosition,
): string {
  const path = tag.slice(directive.length).trim();
  if (path.length === 0) {
    throw syntaxError(`Missing path for ${directive}`, position);
  }
  return path;
}

function parse(template: string): Node[] {
  const root: Node[] = [];
  const stack: Frame[] = [];
  let current = root;
  let offset = 0;

  while (offset < template.length) {
    const open = template.indexOf("{{", offset);
    if (open === -1) {
      current.push({ kind: "text", value: template.slice(offset) });
      break;
    }

    if (open > offset) {
      current.push({ kind: "text", value: template.slice(offset, open) });
    }

    const position = positionAt(template, open);
    const triple = template.startsWith("{{{", open);
    const closeMarker = triple ? "}}}" : "}}";
    const contentStart = open + (triple ? 3 : 2);
    const close = template.indexOf(closeMarker, contentStart);

    if (close === -1) {
      throw syntaxError("Unclosed tag", position);
    }

    const tag = template.slice(contentStart, close).trim();
    offset = close + closeMarker.length;

    if (triple) {
      current.push({ kind: "value", path: tag, escaped: false, position });
      continue;
    }

    if (tag.startsWith("!")) {
      continue;
    }

    if (tag.startsWith("#")) {
      let kind: "if" | "each";
      let directive: string;
      if (/^#if(?:\s|$)/.test(tag)) {
        kind = "if";
        directive = "#if";
      } else if (/^#each(?:\s|$)/.test(tag)) {
        kind = "each";
        directive = "#each";
      } else {
        const name = tag.slice(1).trim().split(/\s+/, 1)[0] || "(empty)";
        throw syntaxError(`Unknown block '${name}'`, position);
      }

      const node: BlockNode = {
        kind,
        path: requirePath(tag, directive, position),
        body: [],
        alternate: [],
        position,
      };
      current.push(node);
      stack.push({ node, parent: current, inAlternate: false });
      current = node.body;
      continue;
    }

    if (tag === "else") {
      const frame = stack.at(-1);
      if (!frame) {
        throw syntaxError("'else' outside a block", position);
      }
      if (frame.inAlternate) {
        throw syntaxError("Duplicate 'else'", position);
      }
      frame.inAlternate = true;
      current = frame.node.alternate;
      continue;
    }

    if (tag.startsWith("/")) {
      const name = tag.slice(1).trim();
      const frame = stack.at(-1);
      if (!frame) {
        throw syntaxError(`Closing block '${name}' has no open block`, position);
      }
      if (name !== "if" && name !== "each") {
        throw syntaxError(`Unknown closing block '${name}'`, position);
      }
      if (frame.node.kind !== name) {
        throw syntaxError(
          `Mismatched closing block: expected '/${frame.node.kind}', got '/${name}'`,
          position,
        );
      }
      stack.pop();
      current = frame.parent;
      continue;
    }

    current.push({ kind: "value", path: tag, escaped: true, position });
  }

  const unclosed = stack.at(-1);
  if (unclosed) {
    throw syntaxError(`Unclosed '${unclosed.node.kind}' block`, unclosed.node.position);
  }

  return root;
}

function property(value: unknown, key: string): unknown | typeof MISSING {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") {
    return MISSING;
  }
  if (!Object.prototype.hasOwnProperty.call(value, key)) {
    return MISSING;
  }
  return (value as Record<string, unknown>)[key];
}

function descend(value: unknown, segments: string[]): unknown | typeof MISSING {
  let result: unknown | typeof MISSING = value;
  for (const segment of segments) {
    result = property(result, segment);
    if (result === MISSING) return MISSING;
  }
  return result;
}

function resolve(path: string, root: unknown, loops: LoopContext[]): unknown | typeof MISSING {
  const segments = path.split(".");
  const loop = loops.at(-1);

  if (segments[0] === "this") {
    return loop ? descend(loop.value, segments.slice(1)) : MISSING;
  }
  if (segments[0] === "@index") {
    return loop && segments.length === 1 ? loop.index : MISSING;
  }

  if (loop) {
    const local = descend(loop.value, segments);
    if (local !== MISSING) return local;
  }
  return descend(root, segments);
}

function isTruthy(value: unknown | typeof MISSING): boolean {
  if (value === MISSING || value == null || value === false || value === "") return false;
  if (value === 0 || value === 0n) return false;
  if (Array.isArray(value) && value.length === 0) return false;
  return true;
}

function scalarText(value: unknown | typeof MISSING, path: string, position: SourcePosition): string {
  if (value === MISSING || value == null) return "";
  if (typeof value === "object" || typeof value === "function") {
    throw syntaxError(`Value '${path}' cannot be rendered as scalar text`, position);
  }
  return String(value);
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

function renderNodes(nodes: Node[], root: unknown, loops: LoopContext[]): string {
  let output = "";

  for (const node of nodes) {
    if (node.kind === "text") {
      output += node.value;
    } else if (node.kind === "value") {
      const text = scalarText(resolve(node.path, root, loops), node.path, node.position);
      output += node.escaped ? escapeHtml(text) : text;
    } else if (node.kind === "if") {
      const branch = isTruthy(resolve(node.path, root, loops)) ? node.body : node.alternate;
      output += renderNodes(branch, root, loops);
    } else {
      const value = resolve(node.path, root, loops);
      if (Array.isArray(value) && value.length > 0) {
        for (let index = 0; index < value.length; index += 1) {
          output += renderNodes(node.body, root, [...loops, { value: value[index], index }]);
        }
      } else {
        output += renderNodes(node.alternate, root, loops);
      }
    }
  }

  return output;
}

/** Render a Mini Template string using the supplied data as its root context. */
export function render(template: string, data: unknown): string {
  return renderNodes(parse(template), data, []);
}
