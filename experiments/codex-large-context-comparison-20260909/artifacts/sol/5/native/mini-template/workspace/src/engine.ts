type Position = {
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
  position: Position;
};

type BlockNode = {
  kind: "if" | "each";
  path: string;
  body: Node[];
  alternate: Node[];
  hasElse: boolean;
  position: Position;
};

type Node = TextNode | ValueNode | BlockNode;

type Frame = {
  node: BlockNode | null;
  output: Node[];
};

type LoopContext = {
  value: unknown;
  index: number;
};

const MISSING = Symbol("missing template value");

/** Render a Mini Template string using values from data. */
export function render(template: string, data: unknown): string {
  if (typeof template !== "string") {
    throw new TypeError("Template must be a string");
  }

  return renderNodes(parse(template), data, []);
}

function parse(template: string): Node[] {
  const root: Node[] = [];
  const stack: Frame[] = [{ node: null, output: root }];
  const lineStarts = findLineStarts(template);
  let cursor = 0;

  while (cursor < template.length) {
    const opening = template.indexOf("{{", cursor);
    if (opening === -1) {
      appendText(stack, template.slice(cursor));
      break;
    }

    appendText(stack, template.slice(cursor, opening));
    const triple = template.startsWith("{{{", opening);
    const closingText = triple ? "}}}" : "}}";
    const contentStart = opening + (triple ? 3 : 2);
    const closing = template.indexOf(closingText, contentStart);
    const position = positionAt(lineStarts, opening);

    if (closing === -1) {
      syntaxError("Unclosed tag", position);
    }

    const tag = template.slice(contentStart, closing).trim();
    cursor = closing + closingText.length;

    if (triple) {
      appendValue(stack, tag, false, position);
      continue;
    }

    if (tag.startsWith("!")) continue;

    if (tag === "else") {
      const frame = stack[stack.length - 1];
      if (!frame.node) syntaxError("else outside a block", position);
      if (frame.node.hasElse) syntaxError("Duplicate else", position);
      frame.node.hasElse = true;
      frame.output = frame.node.alternate;
      continue;
    }

    if (tag.startsWith("#")) {
      const match = /^#(if|each)(?:\s+(.+))$/.exec(tag);
      if (!match) {
        const name = tag.slice(1).split(/\s/, 1)[0] || "(empty)";
        syntaxError(`Unknown or malformed block '${name}'`, position);
      }

      const node: BlockNode = {
        kind: match[1] as "if" | "each",
        path: match[2].trim(),
        body: [],
        alternate: [],
        hasElse: false,
        position,
      };
      if (!node.path) syntaxError(`Missing path for ${node.kind} block`, position);
      stack[stack.length - 1].output.push(node);
      stack.push({ node, output: node.body });
      continue;
    }

    if (tag.startsWith("/")) {
      const name = tag.slice(1).trim();
      if (name !== "if" && name !== "each") {
        syntaxError(`Unknown closing block '${name || "(empty)"}'`, position);
      }
      const frame = stack[stack.length - 1];
      if (!frame.node) syntaxError(`Closing ${name} without an open block`, position);
      if (frame.node.kind !== name) {
        syntaxError(`Mismatched closing block: expected /${frame.node.kind}, found /${name}`, position);
      }
      stack.pop();
      continue;
    }

    appendValue(stack, tag, true, position);
  }

  if (stack.length > 1) {
    const node = stack[stack.length - 1].node!;
    syntaxError(`Unclosed ${node.kind} block`, node.position);
  }

  return root;
}

function appendText(stack: Frame[], value: string): void {
  if (value) stack[stack.length - 1].output.push({ kind: "text", value });
}

function appendValue(stack: Frame[], path: string, escaped: boolean, position: Position): void {
  stack[stack.length - 1].output.push({ kind: "value", path, escaped, position });
}

function renderNodes(nodes: Node[], root: unknown, loops: LoopContext[]): string {
  let output = "";

  for (const node of nodes) {
    if (node.kind === "text") {
      output += node.value;
      continue;
    }

    if (node.kind === "value") {
      const value = resolve(node.path, root, loops);
      const text = scalarText(value, node.path, node.position);
      output += node.escaped ? escapeHtml(text) : text;
      continue;
    }

    const value = resolve(node.path, root, loops);
    if (node.kind === "if") {
      output += renderNodes(isTruthy(value) ? node.body : node.alternate, root, loops);
      continue;
    }

    if (Array.isArray(value) && value.length > 0) {
      for (let index = 0; index < value.length; index++) {
        output += renderNodes(node.body, root, [...loops, { value: value[index], index }]);
      }
    } else {
      output += renderNodes(node.alternate, root, loops);
    }
  }

  return output;
}

function resolve(path: string, root: unknown, loops: LoopContext[]): unknown | typeof MISSING {
  if (!path) return MISSING;

  const parts = path.split(".");
  if (parts.some((part) => part.length === 0)) return MISSING;

  if (parts[0] === "this") {
    if (loops.length === 0) return MISSING;
    return getPath(loops[loops.length - 1].value, parts.slice(1));
  }

  if (parts[0] === "@index") {
    if (loops.length === 0 || parts.length !== 1) return MISSING;
    return loops[loops.length - 1].index;
  }

  // A loop item may provide ordinary names. Search outward through nested loops,
  // then use the root object, so root data remains available in every block.
  for (let index = loops.length - 1; index >= 0; index--) {
    const value = getPath(loops[index].value, parts);
    if (value !== MISSING) return value;
  }

  return getPath(root, parts);
}

function getPath(source: unknown, parts: string[]): unknown | typeof MISSING {
  let value = source;
  for (const part of parts) {
    if ((typeof value !== "object" || value === null) && typeof value !== "function") {
      return MISSING;
    }
    if (!Object.prototype.hasOwnProperty.call(value, part)) return MISSING;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

function scalarText(value: unknown | typeof MISSING, path: string, position: Position): string {
  if (value === MISSING || value === null || value === undefined) return "";

  switch (typeof value) {
    case "string":
      return value;
    case "number":
    case "bigint":
    case "boolean":
      return String(value);
    default:
      throw new Error(
        `Cannot render non-scalar value for '${path || "(empty path)"}' at line ${position.line}, column ${position.column}`,
      );
  }
}

function isTruthy(value: unknown | typeof MISSING): boolean {
  if (value === MISSING || value === null || value === undefined || value === false || value === "") return false;
  if ((typeof value === "number" || typeof value === "bigint") && value === 0) return false;
  if (Array.isArray(value) && value.length === 0) return false;
  return true;
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

function findLineStarts(template: string): number[] {
  const starts = [0];
  for (let index = 0; index < template.length; index++) {
    if (template.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

function positionAt(lineStarts: number[], offset: number): Position {
  let low = 0;
  let high = lineStarts.length;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (lineStarts[middle] <= offset) low = middle;
    else high = middle;
  }
  return { line: low + 1, column: offset - lineStarts[low] + 1 };
}

function syntaxError(message: string, position: Position): never {
  throw new SyntaxError(`${message} at line ${position.line}, column ${position.column}`);
}
