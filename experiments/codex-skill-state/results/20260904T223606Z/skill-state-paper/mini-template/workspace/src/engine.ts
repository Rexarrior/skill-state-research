type Node = TextNode | InterpolationNode | BlockNode;

interface Position {
  line: number;
  column: number;
}

interface TextNode {
  kind: "text";
  text: string;
}

interface InterpolationNode {
  kind: "interpolation";
  path: string;
  escaped: boolean;
  position: Position;
}

interface BlockNode {
  kind: "block";
  name: "if" | "each";
  path: string;
  body: Node[];
  alternate: Node[] | null;
  position: Position;
}

interface Frame {
  block: BlockNode;
  target: Node[];
}

interface Scope {
  root: unknown;
  value: unknown;
  index: number | undefined;
}

function locationAt(source: string, offset: number): Position {
  const before = source.slice(0, offset);
  const line = before.split("\n").length;
  const lastNewline = before.lastIndexOf("\n");
  return { line, column: offset - lastNewline };
}

function errorAt(message: string, position: Position): Error {
  return new Error(`${message} at line ${position.line}, column ${position.column}`);
}

function parse(source: string): Node[] {
  const root: Node[] = [];
  const stack: Frame[] = [];
  let target = root;
  let cursor = 0;

  const appendText = (text: string) => {
    if (text) target.push({ kind: "text", text });
  };

  while (cursor < source.length) {
    const opening = source.indexOf("{{", cursor);
    if (opening === -1) {
      appendText(source.slice(cursor));
      break;
    }
    appendText(source.slice(cursor, opening));

    const triple = source.startsWith("{{{", opening);
    const closing = source.indexOf(triple ? "}}}" : "}}", opening + (triple ? 3 : 2));
    const position = locationAt(source, opening);
    if (closing === -1) throw errorAt("Unclosed tag", position);

    const content = source.slice(opening + (triple ? 3 : 2), closing).trim();
    cursor = closing + (triple ? 3 : 2);

    if (triple) {
      if (!content) throw errorAt("Interpolation path cannot be empty", position);
      target.push({ kind: "interpolation", path: content, escaped: false, position });
      continue;
    }
    if (!content || content.startsWith("!")) continue;

    if (content === "else") {
      const frame = stack.at(-1);
      if (!frame) throw errorAt("'else' outside a block", position);
      if (frame.block.alternate) throw errorAt(`Duplicate 'else' for '${frame.block.name}' block`, position);
      frame.block.alternate = [];
      frame.target = frame.block.alternate;
      target = frame.target;
      continue;
    }

    if (content.startsWith("#")) {
      const [name, ...parts] = content.slice(1).trim().split(/\s+/);
      const path = parts.join(" ");
      if (name !== "if" && name !== "each") throw errorAt(`Unknown block '${name || ""}'`, position);
      if (!path) throw errorAt(`Block '${name}' requires a path`, position);
      const block: BlockNode = { kind: "block", name, path, body: [], alternate: null, position };
      target.push(block);
      stack.push({ block, target: block.body });
      target = block.body;
      continue;
    }

    if (content.startsWith("/")) {
      const name = content.slice(1).trim();
      const frame = stack.at(-1);
      if (!frame) throw errorAt(`Closing '${name}' without an open block`, position);
      if (name !== frame.block.name) {
        throw errorAt(`Mismatched closing tag: expected '/${frame.block.name}', got '/${name}'`, position);
      }
      stack.pop();
      target = stack.at(-1)?.target ?? root;
      continue;
    }

    target.push({ kind: "interpolation", path: content, escaped: true, position });
  }

  const unclosed = stack.at(-1);
  if (unclosed) throw errorAt(`Unclosed '${unclosed.block.name}' block`, unclosed.block.position);
  return root;
}

function getProperty(value: unknown, key: string): unknown {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "object" && typeof value !== "function") return undefined;
  return (value as Record<string, unknown>)[key];
}

function resolve(path: string, scope: Scope): unknown {
  if (path === "this") return scope.value;
  if (path === "@index") return scope.index;

  const parts = path.split(".");
  let value: unknown = scope.root;
  for (const part of parts) value = getProperty(value, part);
  return value;
}

function isTruthy(value: unknown): boolean {
  return !(value === false || value === null || value === undefined || value === 0 || value === "" || (Array.isArray(value) && value.length === 0));
}

function scalar(value: unknown, position: Position): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object" || typeof value === "function" || typeof value === "symbol") {
    throw errorAt("Cannot render an object, function, or symbol as text", position);
  }
  return String(value);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

function renderNodes(nodes: Node[], scope: Scope): string {
  let output = "";
  for (const node of nodes) {
    if (node.kind === "text") output += node.text;
    else if (node.kind === "interpolation") {
      const value = scalar(resolve(node.path, scope), node.position);
      output += node.escaped ? escapeHtml(value) : value;
    } else {
      const value = resolve(node.path, scope);
      if (node.name === "if") {
        output += renderNodes(isTruthy(value) ? node.body : (node.alternate ?? []), scope);
      } else if (Array.isArray(value) && value.length > 0) {
        value.forEach((item, index) => {
          output += renderNodes(node.body, { root: scope.root, value: item, index });
        });
      } else {
        output += renderNodes(node.alternate ?? [], scope);
      }
    }
  }
  return output;
}

/** Render a Mini Template string with the supplied data object. */
export function render(template: string, data: unknown): string {
  return renderNodes(parse(template), { root: data, value: data, index: undefined });
}
