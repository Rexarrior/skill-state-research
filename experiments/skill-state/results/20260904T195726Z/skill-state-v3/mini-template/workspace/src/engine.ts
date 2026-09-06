type TextNode = { type: "text"; value: string };
type ValueNode = { type: "value"; path: string; escaped: boolean; offset: number };
type BlockNode = {
  type: "if" | "each";
  path: string;
  body: Node[];
  alternate: Node[];
  offset: number;
  hasElse: boolean;
};
type Node = TextNode | ValueNode | BlockNode;

type Frame = { block: BlockNode; parent: Node[] };
type Context = { root: unknown; current: unknown; indexes: number[] };

function location(source: string, offset: number): string {
  const before = source.slice(0, offset);
  const line = before.split("\n").length;
  const lastNewline = before.lastIndexOf("\n");
  return `line ${line}, column ${offset - lastNewline}`;
}

function syntaxError(source: string, offset: number, message: string): Error {
  return new Error(`${message} at ${location(source, offset)}`);
}

function parse(source: string): Node[] {
  const root: Node[] = [];
  const stack: Frame[] = [];
  let output = root;
  let cursor = 0;

  while (cursor < source.length) {
    const start = source.indexOf("{{", cursor);
    if (start === -1) {
      output.push({ type: "text", value: source.slice(cursor) });
      break;
    }
    if (start > cursor) output.push({ type: "text", value: source.slice(cursor, start) });

    const triple = source.startsWith("{{{", start);
    const close = triple ? "}}}" : "}}";
    const end = source.indexOf(close, start + (triple ? 3 : 2));
    if (end === -1) throw syntaxError(source, start, "Unclosed tag");
    const content = source.slice(start + (triple ? 3 : 2), end).trim();
    cursor = end + close.length;

    if (!content) throw syntaxError(source, start, "Empty tag");
    if (!triple && content.startsWith("!")) continue;

    if (!triple && content.startsWith("#")) {
      const match = content.match(/^#(if|each)\s+(.+)$/);
      if (!match) throw syntaxError(source, start, `Unknown or malformed block '${content}'`);
      const block: BlockNode = {
        type: match[1] as "if" | "each",
        path: match[2].trim(),
        body: [],
        alternate: [],
        offset: start,
        hasElse: false,
      };
      output.push(block);
      stack.push({ block, parent: output });
      output = block.body;
      continue;
    }

    if (!triple && content === "else") {
      const frame = stack.at(-1);
      if (!frame) throw syntaxError(source, start, "'else' outside a block");
      if (frame.block.hasElse) throw syntaxError(source, start, "Duplicate 'else'");
      frame.block.hasElse = true;
      output = frame.block.alternate;
      continue;
    }

    if (!triple && content.startsWith("/")) {
      const name = content.slice(1).trim();
      const frame = stack.at(-1);
      if (!frame) throw syntaxError(source, start, `Unexpected closing block '${name}'`);
      if (name !== frame.block.type) {
        throw syntaxError(source, start, `Mismatched closing block '${name}', expected '${frame.block.type}'`);
      }
      stack.pop();
      output = frame.parent;
      continue;
    }

    output.push({ type: "value", path: content, escaped: !triple, offset: start });
  }

  const unclosed = stack.at(-1)?.block;
  if (unclosed) throw syntaxError(source, unclosed.offset, `Unclosed '${unclosed.type}' block`);
  return root;
}

function property(value: unknown, parts: string[]): unknown {
  let result = value;
  for (const part of parts) {
    if (result === null || result === undefined || (typeof result !== "object" && typeof result !== "function")) {
      return undefined;
    }
    result = (result as Record<string, unknown>)[part];
  }
  return result;
}

function resolve(path: string, context: Context): unknown {
  if (path === "this") return context.current;
  if (path === "@index") return context.indexes.at(-1);

  if (path.startsWith("this.")) return property(context.current, path.slice(5).split("."));
  const parts = path.split(".");
  const local = property(context.current, parts);
  return local === undefined && context.current !== context.root ? property(context.root, parts) : local;
}

function isTruthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return value !== "" && value !== 0 && value !== false && value !== null && value !== undefined;
}

function scalar(value: unknown, source: string, offset: number): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object" || typeof value === "function") {
    throw syntaxError(source, offset, "Cannot render a non-scalar value");
  }
  return String(value);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]!);
}

function renderNodes(nodes: Node[], context: Context, source: string): string {
  let result = "";
  for (const node of nodes) {
    if (node.type === "text") {
      result += node.value;
    } else if (node.type === "value") {
      const value = scalar(resolve(node.path, context), source, node.offset);
      result += node.escaped ? escapeHtml(value) : value;
    } else if (node.type === "if") {
      const branch = isTruthy(resolve(node.path, context)) ? node.body : node.alternate;
      result += renderNodes(branch, context, source);
    } else {
      const value = resolve(node.path, context);
      if (!Array.isArray(value) || value.length === 0) {
        result += renderNodes(node.alternate, context, source);
      } else {
        value.forEach((item, index) => {
          result += renderNodes(node.body, {
            root: context.root,
            current: item,
            indexes: [...context.indexes, index],
          }, source);
        });
      }
    }
  }
  return result;
}

export function render(template: string, data: unknown): string {
  return renderNodes(parse(template), { root: data, current: data, indexes: [] }, template);
}
