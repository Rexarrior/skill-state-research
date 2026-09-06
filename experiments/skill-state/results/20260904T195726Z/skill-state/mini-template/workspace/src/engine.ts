type Location = { line: number; column: number };

type Node =
  | { kind: "text"; value: string }
  | { kind: "value"; path: string; escaped: boolean; location: Location }
  | { kind: "if" | "each"; path: string; body: Node[]; alternate: Node[]; location: Location };

type BlockNode = Extract<Node, { kind: "if" | "each" }>;
type Frame = { node: BlockNode; parent: Node[]; inElse: boolean };
type Scope = { value: unknown; index?: number };

function locationAt(source: string, offset: number): Location {
  const before = source.slice(0, offset);
  const line = before.split("\n").length;
  const lastNewline = before.lastIndexOf("\n");
  return { line, column: offset - lastNewline };
}

function syntaxError(message: string, location: Location): Error {
  return new Error(`${message} at line ${location.line}, column ${location.column}`);
}

function parse(template: string): Node[] {
  const root: Node[] = [];
  let current = root;
  const stack: Frame[] = [];
  const tags = /{{{[\s\S]*?}}}|{{[\s\S]*?}}/g;
  let cursor = 0;

  for (const match of template.matchAll(tags)) {
    const offset = match.index;
    if (offset > cursor) current.push({ kind: "text", value: template.slice(cursor, offset) });

    const raw = match[0];
    const triple = raw.startsWith("{{{");
    const content = raw.slice(triple ? 3 : 2, triple ? -3 : -2).trim();
    const location = locationAt(template, offset);

    if (!triple && content.startsWith("!")) {
      // Comments intentionally emit no node.
    } else if (!triple && content.startsWith("#")) {
      const blockMatch = /^#(if|each)(?:\s+(.+))$/.exec(content);
      if (!blockMatch || !blockMatch[2].trim()) {
        throw syntaxError(`Unknown or invalid block "${content}"`, location);
      }
      const node: BlockNode = {
        kind: blockMatch[1] as "if" | "each",
        path: blockMatch[2].trim(),
        body: [],
        alternate: [],
        location,
      };
      current.push(node);
      stack.push({ node, parent: current, inElse: false });
      current = node.body;
    } else if (!triple && content === "else") {
      const frame = stack.at(-1);
      if (!frame) throw syntaxError("Else outside a block", location);
      if (frame.inElse) throw syntaxError("Duplicate else", location);
      frame.inElse = true;
      current = frame.node.alternate;
    } else if (!triple && content.startsWith("/")) {
      const close = content.slice(1).trim();
      const frame = stack.at(-1);
      if (!frame) throw syntaxError(`Unexpected closing block "${close}"`, location);
      if (close !== frame.node.kind) {
        throw syntaxError(`Mismatched closing block "${close}"; expected "${frame.node.kind}"`, location);
      }
      stack.pop();
      current = frame.parent;
    } else if (!triple && content.startsWith("#")) {
      throw syntaxError(`Unknown block "${content}"`, location);
    } else if (!triple && content.startsWith("/")) {
      throw syntaxError(`Invalid closing block "${content}"`, location);
    } else {
      current.push({ kind: "value", path: content, escaped: !triple, location });
    }

    cursor = offset + raw.length;
  }

  if (cursor < template.length) current.push({ kind: "text", value: template.slice(cursor) });
  const frame = stack.at(-1);
  if (frame) throw syntaxError(`Unclosed block "${frame.node.kind}"`, frame.node.location);
  return root;
}

function getPath(value: unknown, path: string): { found: boolean; value: unknown } {
  if (path === "") return { found: false, value: undefined };
  let current = value;
  for (const part of path.split(".")) {
    if ((typeof current !== "object" || current === null) && typeof current !== "function") {
      return { found: false, value: undefined };
    }
    if (!Object.prototype.hasOwnProperty.call(current, part)) return { found: false, value: undefined };
    current = (current as Record<string, unknown>)[part];
  }
  return { found: true, value: current };
}

function resolve(path: string, scopes: Scope[], root: unknown): unknown {
  const scope = scopes.at(-1);
  if (path === "this") return scope?.value;
  if (path.startsWith("this.")) return getPath(scope?.value, path.slice(5)).value;
  if (path === "@index") return scope?.index;

  if (scope) {
    const local = getPath(scope.value, path);
    if (local.found) return local.value;
  }
  return getPath(root, path).value;
}

function isTruthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return value !== "" && value !== 0 && value !== false && value !== null && value !== undefined;
}

function scalar(value: unknown, path: string, location: Location): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object" || typeof value === "function") {
    throw syntaxError(`Value at "${path}" cannot be rendered as scalar text`, location);
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

function renderNodes(nodes: Node[], root: unknown, scopes: Scope[]): string {
  let output = "";
  for (const node of nodes) {
    if (node.kind === "text") {
      output += node.value;
      continue;
    }

    const value = resolve(node.path, scopes, root);
    if (node.kind === "value") {
      const text = scalar(value, node.path, node.location);
      output += node.escaped ? escapeHtml(text) : text;
    } else if (node.kind === "if") {
      output += renderNodes(isTruthy(value) ? node.body : node.alternate, root, scopes);
    } else if (Array.isArray(value) && value.length > 0) {
      for (let index = 0; index < value.length; index++) {
        output += renderNodes(node.body, root, [...scopes, { value: value[index], index }]);
      }
    } else {
      output += renderNodes(node.alternate, root, scopes);
    }
  }
  return output;
}

export function render(template: string, data: unknown): string {
  return renderNodes(parse(template), data, []);
}
