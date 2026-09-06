type Location = {
  line: number;
  column: number;
};

type Node =
  | { type: "text"; value: string }
  | { type: "value"; path: string; escaped: boolean; location: Location }
  | {
      type: "block";
      kind: "if" | "each";
      path: string;
      body: Node[];
      alternate: Node[] | null;
      location: Location;
    };

type BlockNode = Extract<Node, { type: "block" }>;

type Frame = {
  block: BlockNode;
  parent: Node[];
  inElse: boolean;
};

type Scope = {
  value: unknown;
  index: number;
};

const MISSING = Symbol("missing");

export class TemplateError extends Error {
  readonly line: number;
  readonly column: number;

  constructor(message: string, location: Location) {
    super(`${message} at line ${location.line}, column ${location.column}`);
    this.name = "TemplateError";
    this.line = location.line;
    this.column = location.column;
  }
}

function locationAt(source: string, offset: number): Location {
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

function requirePath(path: string, location: Location): string {
  if (!path || /[\s{}]/.test(path) || path.split(".").some((part) => !part)) {
    throw new TemplateError(`Invalid path ${JSON.stringify(path)}`, location);
  }
  return path;
}

function parse(template: string): Node[] {
  const root: Node[] = [];
  const stack: Frame[] = [];
  let current = root;
  let cursor = 0;

  while (cursor < template.length) {
    const open = template.indexOf("{{", cursor);
    if (open === -1) {
      current.push({ type: "text", value: template.slice(cursor) });
      break;
    }
    if (open > cursor) {
      current.push({ type: "text", value: template.slice(cursor, open) });
    }

    const triple = template.startsWith("{{{", open);
    const closing = triple ? "}}}" : "}}";
    const contentStart = open + (triple ? 3 : 2);
    const close = template.indexOf(closing, contentStart);
    const location = locationAt(template, open);
    if (close === -1) {
      throw new TemplateError("Unclosed tag", location);
    }

    const content = template.slice(contentStart, close).trim();
    cursor = close + closing.length;

    if (triple) {
      current.push({
        type: "value",
        path: requirePath(content, location),
        escaped: false,
        location,
      });
      continue;
    }

    if (content.startsWith("!")) continue;

    if (content.startsWith("#")) {
      const match = /^#([^\s]+)(?:\s+(.+))?$/.exec(content);
      const kind = match?.[1];
      if (kind !== "if" && kind !== "each") {
        throw new TemplateError(`Unknown block ${JSON.stringify(kind ?? content.slice(1))}`, location);
      }
      const block: BlockNode = {
        type: "block",
        kind,
        path: requirePath(match?.[2]?.trim() ?? "", location),
        body: [],
        alternate: null,
        location,
      };
      current.push(block);
      stack.push({ block, parent: current, inElse: false });
      current = block.body;
      continue;
    }

    if (content === "else" || content.startsWith("else ")) {
      if (content !== "else") {
        throw new TemplateError("The else tag cannot have arguments", location);
      }
      const frame = stack.at(-1);
      if (!frame) throw new TemplateError("Else outside a block", location);
      if (frame.inElse) throw new TemplateError("Duplicate else", location);
      frame.inElse = true;
      frame.block.alternate = [];
      current = frame.block.alternate;
      continue;
    }

    if (content.startsWith("/")) {
      const closeKind = content.slice(1).trim();
      const frame = stack.at(-1);
      if (!frame) throw new TemplateError(`Closing ${JSON.stringify(closeKind)} without an open block`, location);
      if (closeKind !== frame.block.kind) {
        throw new TemplateError(
          `Mismatched closing block: expected /${frame.block.kind}, found /${closeKind}`,
          location,
        );
      }
      stack.pop();
      current = frame.parent;
      continue;
    }

    current.push({
      type: "value",
      path: requirePath(content, location),
      escaped: true,
      location,
    });
  }

  const unclosed = stack.at(-1)?.block;
  if (unclosed) {
    throw new TemplateError(`Unclosed ${unclosed.kind} block`, unclosed.location);
  }
  return root;
}

function property(value: unknown, parts: string[]): unknown | typeof MISSING {
  let current = value;
  for (const part of parts) {
    if ((typeof current !== "object" && typeof current !== "function") || current === null) {
      return MISSING;
    }
    if (!Object.prototype.hasOwnProperty.call(current, part)) return MISSING;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function resolve(path: string, root: unknown, scopes: Scope[]): unknown | typeof MISSING {
  if (path === "this") return scopes.at(-1)?.value ?? MISSING;
  if (path === "@index") return scopes.at(-1)?.index ?? MISSING;

  if (path.startsWith("this.")) {
    const scope = scopes.at(-1);
    return scope ? property(scope.value, path.slice(5).split(".")) : MISSING;
  }

  const parts = path.split(".");
  for (let i = scopes.length - 1; i >= 0; i--) {
    const result = property(scopes[i].value, parts);
    if (result !== MISSING) return result;
  }
  return property(root, parts);
}

function isTruthy(value: unknown | typeof MISSING): boolean {
  if (value === MISSING || value === null || value === undefined || value === false || value === 0 || value === "") {
    return false;
  }
  return !Array.isArray(value) || value.length > 0;
}

function scalar(value: unknown | typeof MISSING, path: string, location: Location): string {
  if (value === MISSING || value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  throw new TemplateError(`Value at ${JSON.stringify(path)} is not scalar text`, location);
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

function renderNodes(nodes: Node[], root: unknown, scopes: Scope[]): string {
  let output = "";
  for (const node of nodes) {
    if (node.type === "text") {
      output += node.value;
    } else if (node.type === "value") {
      const value = scalar(resolve(node.path, root, scopes), node.path, node.location);
      output += node.escaped ? escapeHtml(value) : value;
    } else if (node.kind === "if") {
      const branch = isTruthy(resolve(node.path, root, scopes)) ? node.body : node.alternate;
      if (branch) output += renderNodes(branch, root, scopes);
    } else {
      const value = resolve(node.path, root, scopes);
      if (Array.isArray(value) && value.length > 0) {
        for (let index = 0; index < value.length; index++) {
          output += renderNodes(node.body, root, [...scopes, { value: value[index], index }]);
        }
      } else if (node.alternate) {
        output += renderNodes(node.alternate, root, scopes);
      }
    }
  }
  return output;
}

export function render(template: string, data: unknown): string {
  return renderNodes(parse(template), data, []);
}
