type Position = { offset: number; line: number; column: number };

type TextNode = { kind: "text"; value: string };
type ValueNode = { kind: "value"; path: string; escaped: boolean };
type BlockNode = {
  kind: "block";
  block: "if" | "each";
  path: string;
  body: Node[];
  alternate?: Node[];
  hasElse: boolean;
  position: Position;
};
type Node = TextNode | ValueNode | BlockNode;

type Frame = { node: BlockNode; target: Node[] };
type RenderContext = { root: unknown; current: unknown; index?: number };

function positionAt(source: string, offset: number): Position {
  let line = 1;
  let column = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { offset, line, column };
}

function syntaxError(source: string, offset: number, message: string): Error {
  const { line, column } = positionAt(source, offset);
  return new Error(`${message} at line ${line}, column ${column}`);
}

function parsePath(value: string, source: string, offset: number): string {
  const parts = value.trim().split(/\s+/);
  if (parts.length !== 1 || !parts[0]) {
    throw syntaxError(source, offset, "Expected exactly one path");
  }
  return parts[0];
}

function parse(template: string): Node[] {
  const root: Node[] = [];
  const stack: Frame[] = [];
  let target = root;
  let cursor = 0;

  while (cursor < template.length) {
    const start = template.indexOf("{{", cursor);
    if (start === -1) {
      if (cursor < template.length) target.push({ kind: "text", value: template.slice(cursor) });
      break;
    }
    if (start > cursor) target.push({ kind: "text", value: template.slice(cursor, start) });

    const triple = template.startsWith("{{{", start);
    const openerLength = triple ? 3 : 2;
    const close = triple ? "}}}" : "}}";
    const end = template.indexOf(close, start + openerLength);
    if (end === -1) throw syntaxError(template, start, "Unclosed tag");

    const content = template.slice(start + openerLength, end).trim();
    const next = end + close.length;
    if (content.startsWith("!")) {
      cursor = next;
      continue;
    }
    if (triple && (content.startsWith("#") || content === "else" || content.startsWith("/"))) {
      throw syntaxError(template, start, "Structural tags cannot use triple braces");
    }

    if (content.startsWith("#")) {
      const match = /^#(\S+)(?:\s+(.+))?$/.exec(content);
      const name = match?.[1];
      if (name !== "if" && name !== "each") {
        throw syntaxError(template, start, `Unknown block '${name ?? content.slice(1)}'`);
      }
      const node: BlockNode = {
        kind: "block",
        block: name,
        path: parsePath(match?.[2] ?? "", template, start),
        body: [],
        hasElse: false,
        position: positionAt(template, start),
      };
      target.push(node);
      stack.push({ node, target: node.body });
      target = node.body;
    } else if (content === "else" || content.startsWith("else ")) {
      const frame = stack.at(-1);
      if (content !== "else") throw syntaxError(template, start, "'else' cannot have arguments");
      if (!frame) throw syntaxError(template, start, "'else' outside a block");
      if (frame.node.hasElse) throw syntaxError(template, start, "Duplicate 'else'");
      frame.node.hasElse = true;
      frame.node.alternate = [];
      frame.target = frame.node.alternate;
      target = frame.target;
    } else if (content.startsWith("/")) {
      const name = content.slice(1).trim();
      if (name !== "if" && name !== "each") throw syntaxError(template, start, `Unknown block '${name}'`);
      const frame = stack.at(-1);
      if (!frame) throw syntaxError(template, start, `Closing '${name}' without an open block`);
      if (frame.node.block !== name) {
        throw syntaxError(template, start, `Mismatched closing tag: expected '/${frame.node.block}', got '/${name}'`);
      }
      stack.pop();
      target = stack.at(-1)?.target ?? root;
    } else {
      target.push({ kind: "value", path: parsePath(content, template, start), escaped: !triple });
    }
    cursor = next;
  }

  const unclosed = stack.at(-1);
  if (unclosed) {
    throw new Error(`Unclosed '${unclosed.node.block}' block opened at line ${unclosed.node.position.line}, column ${unclosed.node.position.column}`);
  }
  return root;
}

function property(value: unknown, key: string): unknown {
  if (value === null || value === undefined || (typeof value !== "object" && typeof value !== "function")) return undefined;
  return Object.prototype.hasOwnProperty.call(value, key) ? (value as Record<string, unknown>)[key] : undefined;
}

function resolve(path: string, context: RenderContext): unknown {
  if (path === "this") return context.current;
  if (path === "@index") return context.index;
  if (path.startsWith("this.")) {
    return path.slice(5).split(".").reduce<unknown>((value, key) => property(value, key), context.current);
  }
  return path.split(".").reduce<unknown>((value, key) => property(value, key), context.root);
}

function isTruthy(value: unknown): boolean {
  return !(
    value === null ||
    value === undefined ||
    value === false ||
    value === 0 ||
    value === "" ||
    (Array.isArray(value) && value.length === 0)
  );
}

function scalar(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  throw new Error(`Cannot render ${typeof value} as scalar text`);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] as string);
}

function renderNodes(nodes: Node[], context: RenderContext): string {
  let output = "";
  for (const node of nodes) {
    if (node.kind === "text") output += node.value;
    else if (node.kind === "value") {
      const value = scalar(resolve(node.path, context));
      output += node.escaped ? escapeHtml(value) : value;
    } else {
      const value = resolve(node.path, context);
      if (node.block === "if") output += renderNodes(isTruthy(value) ? node.body : (node.alternate ?? []), context);
      else if (Array.isArray(value) && value.length > 0) {
        for (let index = 0; index < value.length; index += 1) {
          output += renderNodes(node.body, { root: context.root, current: value[index], index });
        }
      } else output += renderNodes(node.alternate ?? [], context);
    }
  }
  return output;
}

/** Renders a Mini Template string with values from the root data object. */
export function render(template: string, data: unknown): string {
  return renderNodes(parse(template), { root: data, current: data });
}
