type Position = {
  index: number;
  line: number;
  column: number;
};

type TextNode = { type: "text"; value: string };
type ValueNode = { type: "value"; path: string; escaped: boolean; position: Position };
type BlockNode = {
  type: "if" | "each";
  path: string;
  children: Node[];
  alternate?: Node[];
  position: Position;
};
type Node = TextNode | ValueNode | BlockNode;

type EachContext = {
  value: unknown;
  index: number;
};

const MISSING = Symbol("missing");

function positionAt(template: string, index: number): Position {
  let line = 1;
  let column = 1;
  for (let cursor = 0; cursor < index; cursor++) {
    if (template[cursor] === "\n") {
      line++;
      column = 1;
    } else {
      column++;
    }
  }
  return { index, line, column };
}

function templateError(message: string, position: Position): Error {
  return new Error(`${message} at line ${position.line}, column ${position.column}`);
}

function requirePath(path: string, kind: string, position: Position): string {
  if (!path) {
    throw templateError(`${kind} requires a path`, position);
  }
  return path;
}

function parse(template: string): Node[] {
  const root: Node[] = [];
  const stack: Array<{ block: BlockNode; target: Node[] }> = [];
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

    const position = positionAt(template, open);
    const triple = template.startsWith("{{{", open);
    const closeToken = triple ? "}}}" : "}}";
    const contentStart = open + (triple ? 3 : 2);
    const close = template.indexOf(closeToken, contentStart);
    if (close === -1) {
      throw templateError("Unclosed tag", position);
    }

    const content = template.slice(contentStart, close).trim();
    cursor = close + closeToken.length;

    if (triple) {
      target.push({
        type: "value",
        path: requirePath(content, "Interpolation", position),
        escaped: false,
        position,
      });
      continue;
    }

    if (content.startsWith("!")) {
      continue;
    }

    if (content === "else") {
      const frame = stack.at(-1);
      if (!frame) {
        throw templateError("else outside a block", position);
      }
      if (frame.block.alternate) {
        throw templateError("Duplicate else", position);
      }
      frame.block.alternate = [];
      frame.target = frame.block.alternate;
      target = frame.target;
      continue;
    }

    if (content.startsWith("#")) {
      const match = /^#(\S+)(?:\s+(.*))?$/.exec(content);
      const name = match?.[1] ?? "";
      if (name !== "if" && name !== "each") {
        throw templateError(`Unknown block '${name}'`, position);
      }
      const block: BlockNode = {
        type: name,
        path: requirePath(match?.[2]?.trim() ?? "", `#${name}`, position),
        children: [],
        position,
      };
      target.push(block);
      stack.push({ block, target: block.children });
      target = block.children;
      continue;
    }

    if (content.startsWith("/")) {
      const name = content.slice(1).trim();
      const frame = stack.at(-1);
      if (!frame) {
        throw templateError(`Unexpected closing block '${name}'`, position);
      }
      if (name !== frame.block.type) {
        throw templateError(
          `Mismatched closing block '${name}', expected '${frame.block.type}'`,
          position,
        );
      }
      stack.pop();
      target = stack.at(-1)?.target ?? root;
      continue;
    }

    target.push({
      type: "value",
      path: requirePath(content, "Interpolation", position),
      escaped: true,
      position,
    });
  }

  const unclosed = stack.at(-1)?.block;
  if (unclosed) {
    throw templateError(`Unclosed block '${unclosed.type}'`, unclosed.position);
  }
  return root;
}

function property(value: unknown, parts: string[]): unknown | typeof MISSING {
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

function resolve(path: string, root: unknown, contexts: EachContext[]): unknown | typeof MISSING {
  if (path === "@index") {
    return contexts.at(-1)?.index ?? MISSING;
  }
  if (path === "this") {
    return contexts.at(-1)?.value ?? MISSING;
  }
  if (path.startsWith("this.")) {
    const context = contexts.at(-1);
    return context ? property(context.value, path.slice(5).split(".")) : MISSING;
  }

  const parts = path.split(".");
  for (let index = contexts.length - 1; index >= 0; index--) {
    const value = property(contexts[index]!.value, parts);
    if (value !== MISSING) return value;
  }
  return property(root, parts);
}

function isTruthy(value: unknown | typeof MISSING): boolean {
  if (value === MISSING || value === null || value === undefined || value === false) return false;
  if (value === "" || value === 0) return false;
  return !Array.isArray(value) || value.length > 0;
}

function scalar(value: unknown | typeof MISSING, path: string, position: Position): string {
  if (value === MISSING || value === null || value === undefined) return "";
  switch (typeof value) {
    case "string":
    case "number":
    case "bigint":
    case "boolean":
      return String(value);
    default:
      throw templateError(`Value '${path}' cannot be rendered as scalar text`, position);
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

function renderNodes(nodes: Node[], root: unknown, contexts: EachContext[]): string {
  let output = "";
  for (const node of nodes) {
    if (node.type === "text") {
      output += node.value;
      continue;
    }

    const value = resolve(node.path, root, contexts);
    if (node.type === "value") {
      const text = scalar(value, node.path, node.position);
      output += node.escaped ? escapeHtml(text) : text;
      continue;
    }

    if (node.type === "if") {
      output += renderNodes(isTruthy(value) ? node.children : (node.alternate ?? []), root, contexts);
      continue;
    }

    if (Array.isArray(value) && value.length > 0) {
      for (let index = 0; index < value.length; index++) {
        output += renderNodes(node.children, root, [...contexts, { value: value[index], index }]);
      }
    } else {
      output += renderNodes(node.alternate ?? [], root, contexts);
    }
  }
  return output;
}

export function render(template: string, data: unknown): string {
  return renderNodes(parse(template), data, []);
}
