type Position = { line: number; column: number };

type Node =
  | { kind: "text"; value: string }
  | { kind: "value"; path: string; escaped: boolean; position: Position }
  | {
      kind: "block";
      block: "if" | "each";
      path: string;
      body: Node[];
      alternate: Node[];
      position: Position;
    };

type BlockNode = Extract<Node, { kind: "block" }>;
type Frame = { node: BlockNode; parent: Node[]; inAlternate: boolean };
type Context = { value: unknown; index?: number; parent?: Context };

const MISSING = Symbol("missing");

function positionAt(source: string, offset: number): Position {
  const before = source.slice(0, offset);
  const lines = before.split("\n");
  return { line: lines.length, column: lines[lines.length - 1].length + 1 };
}

function syntaxError(message: string, position: Position): Error {
  return new Error(`${message} at line ${position.line}, column ${position.column}`);
}

function parse(template: string): Node[] {
  const root: Node[] = [];
  const stack: Frame[] = [];
  let current = root;
  let cursor = 0;

  while (cursor < template.length) {
    const start = template.indexOf("{{", cursor);
    if (start === -1) {
      current.push({ kind: "text", value: template.slice(cursor) });
      break;
    }
    if (start > cursor) current.push({ kind: "text", value: template.slice(cursor, start) });

    const triple = template.startsWith("{{{", start);
    const close = triple ? "}}}" : "}}";
    const end = template.indexOf(close, start + (triple ? 3 : 2));
    const position = positionAt(template, start);
    if (end === -1) throw syntaxError("Unclosed tag", position);

    const content = template
      .slice(start + (triple ? 3 : 2), end)
      .trim();
    cursor = end + close.length;

    if (!content) throw syntaxError("Empty tag", position);
    if (triple) {
      current.push({ kind: "value", path: content, escaped: false, position });
      continue;
    }
    if (content.startsWith("!")) continue;

    if (content === "else") {
      const frame = stack[stack.length - 1];
      if (!frame) throw syntaxError("else outside a block", position);
      if (frame.inAlternate) throw syntaxError("Duplicate else", position);
      frame.inAlternate = true;
      current = frame.node.alternate;
      continue;
    }

    if (content.startsWith("#")) {
      const match = /^#(\S+)(?:\s+(.+))?$/.exec(content);
      const block = match?.[1];
      const path = match?.[2]?.trim();
      if (block !== "if" && block !== "each") {
        throw syntaxError(`Unknown block ${block ?? content.slice(1)}`, position);
      }
      if (!path) throw syntaxError(`${block} block requires a path`, position);
      const node: BlockNode = { kind: "block", block, path, body: [], alternate: [], position };
      current.push(node);
      stack.push({ node, parent: current, inAlternate: false });
      current = node.body;
      continue;
    }

    if (content.startsWith("/")) {
      const closing = content.slice(1).trim();
      const frame = stack[stack.length - 1];
      if (!frame) throw syntaxError(`Closing ${closing} without an open block`, position);
      if (closing !== frame.node.block) {
        throw syntaxError(`Mismatched closing block: expected /${frame.node.block}, got /${closing}`, position);
      }
      stack.pop();
      current = frame.parent;
      continue;
    }

    current.push({ kind: "value", path: content, escaped: true, position });
  }

  const unclosed = stack[stack.length - 1];
  if (unclosed) throw syntaxError(`Unclosed ${unclosed.node.block} block`, unclosed.node.position);
  return root;
}

function ownPath(value: unknown, path: string): unknown | typeof MISSING {
  let current = value;
  for (const segment of path.split(".")) {
    if ((typeof current !== "object" || current === null) && typeof current !== "function") return MISSING;
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return MISSING;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function resolve(path: string, context: Context, root: unknown): unknown | typeof MISSING {
  if (path === "this") return context.value;
  if (path.startsWith("this.")) return ownPath(context.value, path.slice(5));
  if (path === "@index") return context.index === undefined ? MISSING : context.index;

  const local = ownPath(context.value, path);
  return local === MISSING ? ownPath(root, path) : local;
}

function isTruthy(value: unknown | typeof MISSING): boolean {
  if (value === MISSING || value === null || value === undefined || value === false || value === 0 || value === "") {
    return false;
  }
  return !Array.isArray(value) || value.length > 0;
}

function scalar(value: unknown | typeof MISSING, path: string, position: Position): string {
  if (value === MISSING || value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  throw syntaxError(`Value at ${path} cannot be rendered as scalar text`, position);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character];
  });
}

function renderNodes(nodes: Node[], context: Context, root: unknown): string {
  let output = "";
  for (const node of nodes) {
    if (node.kind === "text") {
      output += node.value;
    } else if (node.kind === "value") {
      const value = scalar(resolve(node.path, context, root), node.path, node.position);
      output += node.escaped ? escapeHtml(value) : value;
    } else if (node.block === "if") {
      const branch = isTruthy(resolve(node.path, context, root)) ? node.body : node.alternate;
      output += renderNodes(branch, context, root);
    } else {
      const value = resolve(node.path, context, root);
      if (Array.isArray(value) && value.length > 0) {
        for (let index = 0; index < value.length; index++) {
          output += renderNodes(node.body, { value: value[index], index, parent: context }, root);
        }
      } else {
        output += renderNodes(node.alternate, context, root);
      }
    }
  }
  return output;
}

export function render(template: string, data: unknown): string {
  return renderNodes(parse(template), { value: data }, data);
}
