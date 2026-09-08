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
  then: Node[];
  otherwise: Node[];
  position: Position;
};
type Node = TextNode | ValueNode | BlockNode;

type Frame = {
  block: BlockNode;
  parent: Node[];
  inElse: boolean;
};

type Scope = {
  root: unknown;
  items: Array<{ value: unknown; index: number }>;
};

const IDENTIFIER = /^(?:this(?:\.[^\s.]+)*|@index|[^\s.]+(?:\.[^\s.]+)*)$/;

function positionAt(source: string, index: number): Position {
  let line = 1;
  let column = 1;

  for (let cursor = 0; cursor < index; cursor++) {
    if (source.charCodeAt(cursor) === 10) {
      line++;
      column = 1;
    } else {
      column++;
    }
  }

  return { index, line, column };
}

function syntaxError(message: string, position: Position): Error {
  return new Error(`${message} at line ${position.line}, column ${position.column}`);
}

function validatePath(path: string, position: Position): string {
  if (!IDENTIFIER.test(path)) {
    throw syntaxError(`Invalid path ${JSON.stringify(path)}`, position);
  }
  return path;
}

function parse(template: string): Node[] {
  const root: Node[] = [];
  const stack: Frame[] = [];
  let output = root;
  let cursor = 0;

  while (cursor < template.length) {
    const opening = template.indexOf("{{", cursor);
    if (opening === -1) {
      output.push({ type: "text", value: template.slice(cursor) });
      break;
    }

    if (opening > cursor) {
      output.push({ type: "text", value: template.slice(cursor, opening) });
    }

    const position = positionAt(template, opening);
    const triple = template.startsWith("{{{", opening);
    const closingText = triple ? "}}}" : "}}";
    const contentStart = opening + (triple ? 3 : 2);
    const closing = template.indexOf(closingText, contentStart);

    if (closing === -1) {
      throw syntaxError(`Unclosed ${triple ? "triple interpolation" : "tag"}`, position);
    }

    const content = template.slice(contentStart, closing).trim();
    cursor = closing + closingText.length;

    if (triple) {
      output.push({ type: "value", path: validatePath(content, position), escaped: false, position });
      continue;
    }

    if (content.startsWith("!")) continue;

    if (content === "else") {
      const frame = stack.at(-1);
      if (!frame) throw syntaxError("Unexpected else outside a block", position);
      if (frame.inElse) throw syntaxError("Duplicate else", position);
      frame.inElse = true;
      output = frame.block.otherwise;
      continue;
    }

    if (content.startsWith("#")) {
      const match = /^#(\S+)(?:\s+(.+?))?$/.exec(content);
      const name = match?.[1] ?? content.slice(1);
      if (name !== "if" && name !== "each") {
        throw syntaxError(`Unknown block ${JSON.stringify(name)}`, position);
      }
      const path = match?.[2];
      if (!path) throw syntaxError(`Missing path for ${name} block`, position);

      const block: BlockNode = {
        type: name,
        path: validatePath(path, position),
        then: [],
        otherwise: [],
        position,
      };
      output.push(block);
      stack.push({ block, parent: output, inElse: false });
      output = block.then;
      continue;
    }

    if (content.startsWith("/")) {
      const name = content.slice(1).trim();
      const frame = stack.at(-1);
      if (!frame) throw syntaxError(`Unexpected closing block ${JSON.stringify(name)}`, position);
      if (name !== frame.block.type) {
        throw syntaxError(
          `Mismatched closing block: expected /${frame.block.type}, received /${name}`,
          position,
        );
      }
      stack.pop();
      output = frame.parent;
      continue;
    }

    output.push({ type: "value", path: validatePath(content, position), escaped: true, position });
  }

  const unclosed = stack.at(-1);
  if (unclosed) {
    throw syntaxError(`Unclosed ${unclosed.block.type} block`, unclosed.block.position);
  }

  return root;
}

function ownValue(value: unknown, segments: string[]): { found: boolean; value: unknown } {
  let current = value;
  for (const segment of segments) {
    if ((typeof current !== "object" || current === null) && typeof current !== "function") {
      return { found: false, value: undefined };
    }
    if (!Object.prototype.hasOwnProperty.call(current, segment)) {
      return { found: false, value: undefined };
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return { found: true, value: current };
}

function resolve(path: string, scope: Scope): unknown {
  if (path === "@index") return scope.items.at(-1)?.index;

  if (path === "this" || path.startsWith("this.")) {
    const current = scope.items.length > 0 ? scope.items.at(-1)!.value : scope.root;
    if (path === "this") return current;
    return ownValue(current, path.slice(5).split(".")).value;
  }

  const segments = path.split(".");
  for (let index = scope.items.length - 1; index >= 0; index--) {
    const result = ownValue(scope.items[index].value, segments);
    if (result.found) return result.value;
  }
  return ownValue(scope.root, segments).value;
}

function isTruthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (value === "" || value === false || value == null) return false;
  if (typeof value === "number" && value === 0) return false;
  if (typeof value === "bigint" && value === 0n) return false;
  return true;
}

function scalarText(value: unknown, path: string, position: Position): string {
  if (value == null) return "";
  switch (typeof value) {
    case "string":
    case "number":
    case "bigint":
    case "boolean":
      return String(value);
    default:
      throw syntaxError(`Value at ${JSON.stringify(path)} is not scalar text`, position);
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

function renderNodes(nodes: Node[], scope: Scope): string {
  let result = "";

  for (const node of nodes) {
    if (node.type === "text") {
      result += node.value;
      continue;
    }

    if (node.type === "value") {
      const text = scalarText(resolve(node.path, scope), node.path, node.position);
      result += node.escaped ? escapeHtml(text) : text;
      continue;
    }

    const value = resolve(node.path, scope);
    if (node.type === "if") {
      result += renderNodes(isTruthy(value) ? node.then : node.otherwise, scope);
      continue;
    }

    if (!Array.isArray(value) || value.length === 0) {
      result += renderNodes(node.otherwise, scope);
      continue;
    }

    for (let index = 0; index < value.length; index++) {
      result += renderNodes(node.then, {
        root: scope.root,
        items: [...scope.items, { value: value[index], index }],
      });
    }
  }

  return result;
}

export function render(template: string, data: unknown): string {
  return renderNodes(parse(template), { root: data, items: [] });
}
