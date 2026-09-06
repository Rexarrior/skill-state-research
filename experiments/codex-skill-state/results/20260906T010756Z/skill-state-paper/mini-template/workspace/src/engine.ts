type Position = { line: number; column: number };

type TextNode = { kind: "text"; value: string };
type ValueNode = { kind: "value"; path: string; escaped: boolean; position: Position };
type BlockNode = {
  kind: "if" | "each";
  path: string;
  body: Node[];
  alternate: Node[];
  position: Position;
};
type Node = TextNode | ValueNode | BlockNode;

type Token =
  | { kind: "text"; value: string; position: Position }
  | { kind: "tag"; value: string; triple: boolean; position: Position };

type Scope = { value: unknown; index?: number; parent?: Scope };

const hasOwn = (value: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

function syntaxError(message: string, position: Position): Error {
  return new Error(`${message} at line ${position.line}, column ${position.column}`);
}

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

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let cursor = 0;

  while (cursor < source.length) {
    const open = source.indexOf("{{", cursor);
    if (open === -1) {
      tokens.push({ kind: "text", value: source.slice(cursor), position: positionAt(source, cursor) });
      break;
    }
    if (open > cursor) {
      tokens.push({ kind: "text", value: source.slice(cursor, open), position: positionAt(source, cursor) });
    }

    const triple = source.startsWith("{{{", open);
    const closeText = triple ? "}}}" : "}}";
    const contentStart = open + (triple ? 3 : 2);
    const close = source.indexOf(closeText, contentStart);
    if (close === -1) throw syntaxError("Unclosed tag", positionAt(source, open));

    tokens.push({
      kind: "tag",
      value: source.slice(contentStart, close).trim(),
      triple,
      position: positionAt(source, open),
    });
    cursor = close + closeText.length;
  }
  return tokens;
}

function parse(source: string): Node[] {
  const tokens = tokenize(source);
  let cursor = 0;

  function sequence(expected?: "if" | "each"): { nodes: Node[]; stop?: "else" | "close"; token?: Token } {
    const nodes: Node[] = [];
    while (cursor < tokens.length) {
      const token = tokens[cursor++]!;
      if (token.kind === "text") {
        nodes.push({ kind: "text", value: token.value });
        continue;
      }

      const tag = token.value;
      if (!tag) throw syntaxError("Empty tag", token.position);
      if (token.triple && (/^[#!/]/.test(tag) || tag === "else")) {
        throw syntaxError("Triple braces may only be used for interpolation", token.position);
      }
      if (tag.startsWith("!")) continue;
      if (tag === "else") {
        if (!expected) throw syntaxError("else outside a block", token.position);
        return { nodes, stop: "else", token };
      }
      if (tag.startsWith("/")) {
        const name = tag.slice(1).trim();
        if (!expected) throw syntaxError(`Unexpected closing block /${name}`, token.position);
        if (name !== expected) {
          throw syntaxError(`Mismatched closing block /${name}; expected /${expected}`, token.position);
        }
        return { nodes, stop: "close", token };
      }
      if (tag.startsWith("#")) {
        const match = /^#(if|each)\s+(.+)$/.exec(tag);
        if (!match) throw syntaxError(`Unknown or malformed block ${tag}`, token.position);
        const kind = match[1] as "if" | "each";
        const path = match[2]!.trim();
        if (!path) throw syntaxError(`${kind} requires a path`, token.position);

        const first = sequence(kind);
        let alternate: Node[] = [];
        if (first.stop === "else") {
          const second = sequence(kind);
          if (second.stop === "else") throw syntaxError("Duplicate else", second.token!.position);
          if (second.stop !== "close") throw syntaxError(`Unclosed ${kind} block`, token.position);
          alternate = second.nodes;
        } else if (first.stop !== "close") {
          throw syntaxError(`Unclosed ${kind} block`, token.position);
        }
        nodes.push({ kind, path, body: first.nodes, alternate, position: token.position });
        continue;
      }
      nodes.push({ kind: "value", path: tag, escaped: !token.triple, position: token.position });
    }
    return { nodes };
  }

  return sequence().nodes;
}

function lookupFrom(value: unknown, parts: string[]): { found: boolean; value: unknown } {
  let current = value;
  for (const part of parts) {
    if ((typeof current !== "object" && typeof current !== "function") || current === null) {
      return { found: false, value: undefined };
    }
    if (!hasOwn(current, part)) return { found: false, value: undefined };
    current = (current as Record<string, unknown>)[part];
  }
  return { found: true, value: current };
}

function resolve(path: string, scope: Scope, root: unknown): unknown {
  if (path === "this" || path === ".") return scope.value;
  if (path === "@index") return scope.index;

  const parts = path.split(".");
  if (parts.some((part) => part.length === 0)) return undefined;
  const local = lookupFrom(scope.value, parts);
  if (local.found) return local.value;
  return scope.value === root ? undefined : lookupFrom(root, parts).value;
}

function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return value !== "" && value !== 0 && value !== false && value !== null && value !== undefined;
}

function scalar(value: unknown, path: string, position: Position): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  throw syntaxError(`Value at '${path}' is not scalar and cannot be rendered`, position);
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

function evaluate(nodes: Node[], scope: Scope, root: unknown): string {
  let output = "";
  for (const node of nodes) {
    if (node.kind === "text") {
      output += node.value;
    } else if (node.kind === "value") {
      const text = scalar(resolve(node.path, scope, root), node.path, node.position);
      output += node.escaped ? escapeHtml(text) : text;
    } else if (node.kind === "if") {
      output += evaluate(truthy(resolve(node.path, scope, root)) ? node.body : node.alternate, scope, root);
    } else {
      const value = resolve(node.path, scope, root);
      if (Array.isArray(value) && value.length > 0) {
        for (let index = 0; index < value.length; index++) {
          output += evaluate(node.body, { value: value[index], index, parent: scope }, root);
        }
      } else {
        output += evaluate(node.alternate, scope, root);
      }
    }
  }
  return output;
}

export function render(template: string, data: unknown): string {
  return evaluate(parse(template), { value: data }, data);
}
