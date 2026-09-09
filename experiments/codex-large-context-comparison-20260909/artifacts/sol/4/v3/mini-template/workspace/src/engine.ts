type Position = {
  offset: number;
  line: number;
  column: number;
};

type TextNode = { kind: "text"; value: string };
type ValueNode = {
  kind: "value";
  path: string;
  escaped: boolean;
  position: Position;
};
type BlockNode = {
  kind: "block";
  blockKind: "if" | "each";
  path: string;
  truthy: Node[];
  alternate: Node[];
  position: Position;
};
type Node = TextNode | ValueNode | BlockNode;

type OpenBlock = {
  node: BlockNode;
  parent: Node[];
  hasElse: boolean;
};

type EachContext = {
  value: unknown;
  index: number;
};

const PATH = /^(?:this|@index|[A-Za-z_$][\w$]*)(?:\.(?:[A-Za-z_$][\w$]*|\d+))*$/;

function positionAt(template: string, offset: number): Position {
  let line = 1;
  let column = 1;
  for (let i = 0; i < offset; i++) {
    if (template.charCodeAt(i) === 10) {
      line++;
      column = 1;
    } else {
      column++;
    }
  }
  return { offset, line, column };
}

function syntaxError(message: string, position: Position): Error {
  return new Error(`${message} at line ${position.line}, column ${position.column}`);
}

function validatePath(path: string, position: Position): void {
  if (!PATH.test(path)) {
    throw syntaxError(path ? `Invalid path "${path}"` : "Expected a path", position);
  }
}

function parse(template: string): Node[] {
  const root: Node[] = [];
  const stack: OpenBlock[] = [];
  let current = root;
  let cursor = 0;

  while (cursor < template.length) {
    const start = template.indexOf("{{", cursor);
    if (start === -1) {
      current.push({ kind: "text", value: template.slice(cursor) });
      break;
    }
    if (start > cursor) {
      current.push({ kind: "text", value: template.slice(cursor, start) });
    }

    const triple = template.startsWith("{{{", start);
    const closing = triple ? "}}}" : "}}";
    const contentStart = start + (triple ? 3 : 2);
    const end = template.indexOf(closing, contentStart);
    const position = positionAt(template, start);
    if (end === -1) {
      throw syntaxError("Unclosed tag", position);
    }

    const tag = template.slice(contentStart, end).trim();
    cursor = end + closing.length;

    if (triple) {
      validatePath(tag, position);
      current.push({ kind: "value", path: tag, escaped: false, position });
      continue;
    }

    if (tag.startsWith("!")) continue;

    if (tag === "else") {
      const open = stack.at(-1);
      if (!open) throw syntaxError("Unexpected else outside a block", position);
      if (open.hasElse) throw syntaxError("Duplicate else", position);
      open.hasElse = true;
      current = open.node.alternate;
      continue;
    }

    if (tag.startsWith("#")) {
      const match = /^#(if|each)(?:\s+)(.+)$/.exec(tag);
      if (!match) {
        const name = /^#([^\s]*)/.exec(tag)?.[1] || "";
        if (name && name !== "if" && name !== "each") {
          throw syntaxError(`Unknown block "${name}"`, position);
        }
        throw syntaxError("Malformed block opening", position);
      }
      const blockKind = match[1] as "if" | "each";
      const path = match[2].trim();
      validatePath(path, position);
      const node: BlockNode = {
        kind: "block",
        blockKind,
        path,
        truthy: [],
        alternate: [],
        position,
      };
      current.push(node);
      stack.push({ node, parent: current, hasElse: false });
      current = node.truthy;
      continue;
    }

    if (tag.startsWith("/")) {
      const name = tag.slice(1).trim();
      const open = stack.at(-1);
      if (!open) throw syntaxError(`Unexpected closing block "${name}"`, position);
      if (name !== open.node.blockKind) {
        throw syntaxError(
          `Mismatched closing block: expected /${open.node.blockKind} but found /${name}`,
          position,
        );
      }
      stack.pop();
      current = open.parent;
      continue;
    }

    validatePath(tag, position);
    current.push({ kind: "value", path: tag, escaped: true, position });
  }

  const unclosed = stack.at(-1);
  if (unclosed) {
    throw syntaxError(`Unclosed ${unclosed.node.blockKind} block`, unclosed.node.position);
  }
  return root;
}

function isContainer(value: unknown): value is Record<string, unknown> {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

function lookup(base: unknown, parts: string[]): { found: boolean; value: unknown } {
  let value = base;
  for (const part of parts) {
    if (!isContainer(value) || !Object.prototype.hasOwnProperty.call(value, part)) {
      return { found: false, value: undefined };
    }
    value = value[part];
  }
  return { found: true, value };
}

function resolve(path: string, root: unknown, contexts: EachContext[]): unknown {
  const parts = path.split(".");
  const current = contexts.at(-1);

  if (parts[0] === "this") {
    return lookup(current?.value, parts.slice(1)).value;
  }
  if (parts[0] === "@index") {
    return parts.length === 1 ? current?.index : undefined;
  }

  if (current) {
    const local = lookup(current.value, parts);
    if (local.found) return local.value;
  }
  return lookup(root, parts).value;
}

function isTruthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return value !== "" && value !== 0 && value !== false && value != null;
}

function scalarText(value: unknown, path: string, position: Position): string {
  if (value == null) return "";
  switch (typeof value) {
    case "string":
    case "number":
    case "boolean":
    case "bigint":
      return String(value);
    default:
      throw syntaxError(`Value at "${path}" is not scalar text`, position);
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
    if (node.kind === "text") {
      output += node.value;
      continue;
    }
    if (node.kind === "value") {
      const text = scalarText(resolve(node.path, root, contexts), node.path, node.position);
      output += node.escaped ? escapeHtml(text) : text;
      continue;
    }

    const value = resolve(node.path, root, contexts);
    if (node.blockKind === "if") {
      output += renderNodes(isTruthy(value) ? node.truthy : node.alternate, root, contexts);
    } else if (Array.isArray(value) && value.length > 0) {
      for (let index = 0; index < value.length; index++) {
        contexts.push({ value: value[index], index });
        output += renderNodes(node.truthy, root, contexts);
        contexts.pop();
      }
    } else {
      output += renderNodes(node.alternate, root, contexts);
    }
  }
  return output;
}

/** Render a Mini Template string with the supplied data. */
export function render(template: string, data: unknown): string {
  return renderNodes(parse(template), data, []);
}
