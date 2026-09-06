type Position = { line: number; column: number };

type TextNode = { kind: "text"; value: string };
type ValueNode = { kind: "value"; path: string; escaped: boolean; position: Position };
type IfNode = {
  kind: "if";
  path: string;
  consequent: Node[];
  alternate: Node[];
  position: Position;
};
type EachNode = {
  kind: "each";
  path: string;
  body: Node[];
  alternate: Node[];
  position: Position;
};
type Node = TextNode | ValueNode | IfNode | EachNode;
type BlockNode = IfNode | EachNode;

type Frame = {
  node: BlockNode;
  parent: Node[];
  inElse: boolean;
};

type Scope = {
  value: unknown;
  index: number;
  parent?: Scope;
};

const pathPattern = /^(?:this|@index)(?:\.[A-Za-z_$][\w$]*|\.\d+)*$|^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\.\d+)*$/;

function positionAt(source: string, offset: number): Position {
  let line = 1;
  let column = 1;
  for (let i = 0; i < offset; i++) {
    if (source.charCodeAt(i) === 10) {
      line++;
      column = 1;
    } else {
      column++;
    }
  }
  return { line, column };
}

function syntaxError(message: string, position: Position): Error {
  return new Error(`${message} at line ${position.line}, column ${position.column}`);
}

function checkPath(path: string, position: Position): string {
  if (!pathPattern.test(path)) {
    throw syntaxError(path ? `Invalid path "${path}"` : "Expected a path", position);
  }
  return path;
}

function parse(template: string): Node[] {
  const root: Node[] = [];
  let current = root;
  const stack: Frame[] = [];
  let cursor = 0;

  while (cursor < template.length) {
    const open = template.indexOf("{{", cursor);
    if (open === -1) {
      current.push({ kind: "text", value: template.slice(cursor) });
      break;
    }
    if (open > cursor) current.push({ kind: "text", value: template.slice(cursor, open) });

    const triple = template.startsWith("{{{", open);
    const closeText = triple ? "}}}" : "}}";
    const contentStart = open + (triple ? 3 : 2);
    const close = template.indexOf(closeText, contentStart);
    const position = positionAt(template, open);
    if (close === -1) throw syntaxError(`Unclosed ${triple ? "triple interpolation" : "tag"}`, position);

    const content = template.slice(contentStart, close).trim();
    cursor = close + closeText.length;

    if (triple) {
      current.push({ kind: "value", path: checkPath(content, position), escaped: false, position });
      continue;
    }
    if (content.startsWith("!")) continue;

    if (content.startsWith("#")) {
      const match = /^#(if|each)(?:\s+)(.+)$/.exec(content);
      if (!match) {
        const name = /^#([^\s]*)/.exec(content)?.[1] || "";
        if (name && name !== "if" && name !== "each") {
          throw syntaxError(`Unknown block "${name}"`, position);
        }
        throw syntaxError("Malformed block opening", position);
      }
      const blockKind = match[1] as "if" | "each";
      const path = checkPath(match[2].trim(), position);
      const node: BlockNode = blockKind === "if"
        ? { kind: "if", path, consequent: [], alternate: [], position }
        : { kind: "each", path, body: [], alternate: [], position };
      current.push(node);
      stack.push({ node, parent: current, inElse: false });
      current = node.kind === "if" ? node.consequent : node.body;
      continue;
    }

    if (content === "else") {
      const frame = stack.at(-1);
      if (!frame) throw syntaxError("Unexpected else outside a block", position);
      if (frame.inElse) throw syntaxError("Duplicate else", position);
      frame.inElse = true;
      current = frame.node.alternate;
      continue;
    }

    if (content.startsWith("/")) {
      const name = content.slice(1).trim();
      if (name !== "if" && name !== "each") {
        throw syntaxError(`Unknown closing block "${name}"`, position);
      }
      const frame = stack.at(-1);
      if (!frame) throw syntaxError(`Unexpected closing block "${name}"`, position);
      if (frame.node.kind !== name) {
        throw syntaxError(`Mismatched closing block "${name}"; expected "${frame.node.kind}"`, position);
      }
      stack.pop();
      current = frame.parent;
      continue;
    }

    current.push({ kind: "value", path: checkPath(content, position), escaped: true, position });
  }

  const unclosed = stack.at(-1);
  if (unclosed) throw syntaxError(`Unclosed block "${unclosed.node.kind}"`, unclosed.node.position);
  return root;
}

function lookupPart(value: unknown, part: string): unknown {
  if (value === null || value === undefined) return undefined;
  if ((typeof value !== "object" && typeof value !== "string") || !Object.prototype.hasOwnProperty.call(value, part)) {
    return undefined;
  }
  return (value as Record<string, unknown>)[part];
}

function follow(value: unknown, parts: string[]): unknown {
  for (const part of parts) value = lookupPart(value, part);
  return value;
}

function resolve(path: string, root: unknown, scope?: Scope): unknown {
  const parts = path.split(".");
  if (parts[0] === "this") return follow(scope?.value, parts.slice(1));
  if (parts[0] === "@index") return follow(scope?.index, parts.slice(1));
  return follow(root, parts);
}

function isTruthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return value !== "" && value !== 0 && value !== false && value !== null && value !== undefined;
}

function scalar(value: unknown, path: string, position: Position): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object" || typeof value === "function") {
    throw syntaxError(`Value at "${path}" is not scalar and cannot be rendered`, position);
  }
  return String(value);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[character]!);
}

function renderNodes(nodes: Node[], root: unknown, scope?: Scope): string {
  let output = "";
  for (const node of nodes) {
    if (node.kind === "text") {
      output += node.value;
    } else if (node.kind === "value") {
      const value = scalar(resolve(node.path, root, scope), node.path, node.position);
      output += node.escaped ? escapeHtml(value) : value;
    } else if (node.kind === "if") {
      const branch = isTruthy(resolve(node.path, root, scope)) ? node.consequent : node.alternate;
      output += renderNodes(branch, root, scope);
    } else {
      const collection = resolve(node.path, root, scope);
      if (Array.isArray(collection) && collection.length > 0) {
        for (let index = 0; index < collection.length; index++) {
          output += renderNodes(node.body, root, { value: collection[index], index, parent: scope });
        }
      } else {
        output += renderNodes(node.alternate, root, scope);
      }
    }
  }
  return output;
}

export function render(template: string, data: unknown): string {
  return renderNodes(parse(template), data);
}
