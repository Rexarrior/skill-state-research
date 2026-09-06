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
  kind: "if" | "each";
  path: string;
  body: Node[];
  alternate: Node[];
  position: Position;
};
type Node = TextNode | ValueNode | BlockNode;

type Frame = {
  node: BlockNode;
  parent: Node[];
  inAlternate: boolean;
};

type Context = {
  root: unknown;
  current: unknown;
  index: number | undefined;
};

const PATH = /^(?:this(?:\.[A-Za-z_$][\w$]*)*|@index|[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)$/;
const MISSING = Symbol("missing");

export class TemplateError extends Error {
  readonly line: number;
  readonly column: number;

  constructor(message: string, position: Position) {
    super(`${message} at line ${position.line}, column ${position.column}`);
    this.name = "TemplateError";
    this.line = position.line;
    this.column = position.column;
  }
}

function positionAt(source: string, offset: number): Position {
  let line = 1;
  let column = 1;

  for (let i = 0; i < offset; i += 1) {
    if (source.charCodeAt(i) === 10) {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }

  return { offset, line, column };
}

function assertPath(path: string, position: Position): void {
  if (!PATH.test(path)) {
    throw new TemplateError(`Invalid path ${JSON.stringify(path)}`, position);
  }
}

function parse(template: string): Node[] {
  const root: Node[] = [];
  const stack: Frame[] = [];
  let output = root;
  let cursor = 0;

  while (cursor < template.length) {
    const opening = template.indexOf("{{", cursor);
    if (opening === -1) {
      output.push({ kind: "text", value: template.slice(cursor) });
      break;
    }

    if (opening > cursor) {
      output.push({ kind: "text", value: template.slice(cursor, opening) });
    }

    const triple = template.startsWith("{{{", opening);
    const closingText = triple ? "}}}" : "}}";
    const contentStart = opening + (triple ? 3 : 2);
    const closing = template.indexOf(closingText, contentStart);
    const position = positionAt(template, opening);

    if (closing === -1) {
      throw new TemplateError(`Unclosed ${triple ? "triple interpolation" : "tag"}`, position);
    }

    const content = template.slice(contentStart, closing).trim();
    cursor = closing + closingText.length;

    if (triple) {
      assertPath(content, position);
      output.push({ kind: "value", path: content, escaped: false, position });
      continue;
    }

    if (content.startsWith("!")) {
      continue;
    }

    if (content === "else") {
      const frame = stack.at(-1);
      if (!frame) {
        throw new TemplateError("Unexpected else outside a block", position);
      }
      if (frame.inAlternate) {
        throw new TemplateError(`Duplicate else in ${frame.node.kind} block`, position);
      }
      frame.inAlternate = true;
      output = frame.node.alternate;
      continue;
    }

    if (content.startsWith("#")) {
      const match = /^#(\S+)(?:\s+(.+))?$/.exec(content);
      const blockName = match?.[1] ?? content.slice(1);
      if (blockName !== "if" && blockName !== "each") {
        throw new TemplateError(`Unknown block ${JSON.stringify(blockName)}`, position);
      }
      const path = match?.[2]?.trim() ?? "";
      assertPath(path, position);
      const node: BlockNode = {
        kind: blockName,
        path,
        body: [],
        alternate: [],
        position,
      };
      output.push(node);
      stack.push({ node, parent: output, inAlternate: false });
      output = node.body;
      continue;
    }

    if (content.startsWith("/")) {
      const closeName = content.slice(1).trim();
      const frame = stack.at(-1);
      if (!frame) {
        throw new TemplateError(`Unexpected closing block ${JSON.stringify(closeName)}`, position);
      }
      if (closeName !== frame.node.kind) {
        throw new TemplateError(
          `Mismatched closing block: expected /${frame.node.kind}, received /${closeName}`,
          position,
        );
      }
      stack.pop();
      output = frame.parent;
      continue;
    }

    assertPath(content, position);
    output.push({ kind: "value", path: content, escaped: true, position });
  }

  const unclosed = stack.at(-1);
  if (unclosed) {
    throw new TemplateError(`Unclosed ${unclosed.node.kind} block`, unclosed.node.position);
  }

  return root;
}

function readPath(value: unknown, parts: string[]): unknown | typeof MISSING {
  let result = value;
  for (const part of parts) {
    if ((typeof result !== "object" || result === null) && typeof result !== "function") {
      return MISSING;
    }
    if (!Object.prototype.hasOwnProperty.call(result, part)) {
      return MISSING;
    }
    result = (result as Record<string, unknown>)[part];
  }
  return result;
}

function resolve(path: string, context: Context): unknown {
  if (path === "@index") {
    return context.index;
  }

  if (path === "this") {
    return context.current;
  }

  if (path.startsWith("this.")) {
    const value = readPath(context.current, path.slice(5).split("."));
    return value === MISSING ? undefined : value;
  }

  const parts = path.split(".");
  const local = readPath(context.current, parts);
  if (local !== MISSING) {
    return local;
  }
  const root = readPath(context.root, parts);
  return root === MISSING ? undefined : root;
}

function isTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === "") {
    return false;
  }
  if (typeof value === "number" && value === 0) {
    return false;
  }
  if (typeof value === "bigint" && value === 0n) {
    return false;
  }
  return !Array.isArray(value) || value.length > 0;
}

function scalarText(value: unknown, path: string, position: Position): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "object" || typeof value === "function") {
    throw new TemplateError(`Cannot render non-scalar value at path ${JSON.stringify(path)}`, position);
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

function renderNodes(nodes: Node[], context: Context): string {
  let result = "";

  for (const node of nodes) {
    if (node.kind === "text") {
      result += node.value;
      continue;
    }

    const value = resolve(node.path, context);
    if (node.kind === "value") {
      const text = scalarText(value, node.path, node.position);
      result += node.escaped ? escapeHtml(text) : text;
      continue;
    }

    if (node.kind === "if") {
      result += renderNodes(isTruthy(value) ? node.body : node.alternate, context);
      continue;
    }

    if (Array.isArray(value) && value.length > 0) {
      for (let index = 0; index < value.length; index += 1) {
        result += renderNodes(node.body, {
          root: context.root,
          current: value[index],
          index,
        });
      }
    } else {
      result += renderNodes(node.alternate, context);
    }
  }

  return result;
}

export function render(template: string, data: unknown): string {
  const nodes = parse(template);
  return renderNodes(nodes, { root: data, current: data, index: undefined });
}
