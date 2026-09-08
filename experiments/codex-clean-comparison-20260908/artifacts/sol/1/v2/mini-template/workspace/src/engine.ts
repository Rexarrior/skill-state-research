type Position = {
  index: number;
};

type Node =
  | { type: "text"; value: string }
  | { type: "value"; path: string; escaped: boolean; position: Position }
  | {
      type: "if";
      path: string;
      consequent: Node[];
      alternate: Node[];
      position: Position;
    }
  | {
      type: "each";
      path: string;
      consequent: Node[];
      alternate: Node[];
      position: Position;
    };

type BlockNode = Extract<Node, { type: "if" | "each" }>;

type Frame = {
  node: BlockNode | null;
  branch: Node[];
  sawElse: boolean;
};

type Scope = {
  value: unknown;
  index: number;
};

const MISSING = Symbol("missing");

function location(template: string, index: number): string {
  let line = 1;
  let column = 1;

  for (let cursor = 0; cursor < index; cursor++) {
    if (template.charCodeAt(cursor) === 10) {
      line++;
      column = 1;
    } else {
      column++;
    }
  }

  return `line ${line}, column ${column}`;
}

function syntaxError(template: string, position: Position, message: string): Error {
  return new Error(`${message} at ${location(template, position.index)}`);
}

function parse(template: string): Node[] {
  const root: Node[] = [];
  const stack: Frame[] = [{ node: null, branch: root, sawElse: false }];
  let cursor = 0;

  const current = (): Frame => stack[stack.length - 1]!;

  while (cursor < template.length) {
    const start = template.indexOf("{{", cursor);
    if (start === -1) {
      current().branch.push({ type: "text", value: template.slice(cursor) });
      break;
    }

    if (start > cursor) {
      current().branch.push({ type: "text", value: template.slice(cursor, start) });
    }

    const position = { index: start };
    const triple = template.startsWith("{{{", start);
    const closing = triple ? "}}}" : "}}";
    const contentStart = start + (triple ? 3 : 2);
    const end = template.indexOf(closing, contentStart);

    if (end === -1) {
      throw syntaxError(template, position, "Unclosed tag");
    }

    const tag = template.slice(contentStart, end).trim();
    cursor = end + closing.length;

    if (triple) {
      if (!tag) {
        throw syntaxError(template, position, "Interpolation path cannot be empty");
      }
      if (/^[#!/]/.test(tag) || tag === "else") {
        throw syntaxError(template, position, "Triple-brace tags may only interpolate values");
      }
      current().branch.push({ type: "value", path: tag, escaped: false, position });
      continue;
    }

    if (tag.startsWith("!")) {
      continue;
    }

    if (tag.startsWith("#")) {
      const match = /^#(if|each)\s+(.+)$/.exec(tag);
      if (!match) {
        const name = /^#([^\s]+)/.exec(tag)?.[1];
        if (name && name !== "if" && name !== "each") {
          throw syntaxError(template, position, `Unknown block \"${name}\"`);
        }
        throw syntaxError(template, position, "Invalid block opening tag");
      }

      const type = match[1] as "if" | "each";
      const path = match[2]!.trim();
      const node: BlockNode = {
        type,
        path,
        consequent: [],
        alternate: [],
        position,
      };
      current().branch.push(node);
      stack.push({ node, branch: node.consequent, sawElse: false });
      continue;
    }

    if (tag === "else") {
      const frame = current();
      if (!frame.node) {
        throw syntaxError(template, position, "else used outside a block");
      }
      if (frame.sawElse) {
        throw syntaxError(template, position, "Duplicate else in block");
      }
      frame.sawElse = true;
      frame.branch = frame.node.alternate;
      continue;
    }

    if (/^else\b/.test(tag)) {
      throw syntaxError(template, position, "Invalid else tag");
    }

    if (tag.startsWith("/")) {
      const name = tag.slice(1).trim();
      if (name !== "if" && name !== "each") {
        throw syntaxError(template, position, `Unknown closing block \"${name}\"`);
      }

      const frame = current();
      if (!frame.node) {
        throw syntaxError(template, position, `Closing ${name} without an open block`);
      }
      if (frame.node.type !== name) {
        throw syntaxError(
          template,
          position,
          `Mismatched closing block: expected /${frame.node.type}, found /${name}`,
        );
      }
      stack.pop();
      continue;
    }

    if (!tag) {
      throw syntaxError(template, position, "Interpolation path cannot be empty");
    }
    current().branch.push({ type: "value", path: tag, escaped: true, position });
  }

  if (stack.length > 1) {
    const frame = current();
    throw syntaxError(
      template,
      frame.node!.position,
      `Unclosed ${frame.node!.type} block`,
    );
  }

  return root;
}

function ownValue(value: unknown, segments: string[]): unknown | typeof MISSING {
  let current = value;

  for (const segment of segments) {
    if ((typeof current !== "object" || current === null) && typeof current !== "function") {
      return MISSING;
    }
    if (!Object.prototype.hasOwnProperty.call(current, segment)) {
      return MISSING;
    }
    current = (current as Record<string, unknown>)[segment];
  }

  return current;
}

function resolve(path: string, root: unknown, scopes: Scope[]): unknown | typeof MISSING {
  if (path === "this") {
    return scopes.length ? scopes[scopes.length - 1]!.value : root;
  }
  if (path.startsWith("this.")) {
    const base = scopes.length ? scopes[scopes.length - 1]!.value : root;
    return ownValue(base, path.slice(5).split("."));
  }
  if (path === "@index") {
    return scopes.length ? scopes[scopes.length - 1]!.index : MISSING;
  }

  const segments = path.split(".");
  for (let index = scopes.length - 1; index >= 0; index--) {
    const found = ownValue(scopes[index]!.value, segments);
    if (found !== MISSING) return found;
  }
  return ownValue(root, segments);
}

function isTruthy(value: unknown | typeof MISSING): boolean {
  if (value === MISSING || value === null || value === undefined || value === false) return false;
  if (value === "" || value === 0 || value === 0n) return false;
  if (Array.isArray(value) && value.length === 0) return false;
  return true;
}

function scalarText(
  value: unknown | typeof MISSING,
  path: string,
  template: string,
  position: Position,
): string {
  if (value === MISSING || value === null || value === undefined) return "";

  switch (typeof value) {
    case "string":
      return value;
    case "number":
    case "bigint":
    case "boolean":
      return String(value);
    default:
      throw syntaxError(
        template,
        position,
        `Value at \"${path}\" cannot be rendered as scalar text`,
      );
  }
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

function renderNodes(nodes: Node[], root: unknown, scopes: Scope[], template: string): string {
  let output = "";

  for (const node of nodes) {
    if (node.type === "text") {
      output += node.value;
      continue;
    }

    const value = resolve(node.path, root, scopes);

    if (node.type === "value") {
      const text = scalarText(value, node.path, template, node.position);
      output += node.escaped ? escapeHtml(text) : text;
    } else if (node.type === "if") {
      output += renderNodes(
        isTruthy(value) ? node.consequent : node.alternate,
        root,
        scopes,
        template,
      );
    } else if (Array.isArray(value) && value.length > 0) {
      for (let index = 0; index < value.length; index++) {
        output += renderNodes(
          node.consequent,
          root,
          [...scopes, { value: value[index], index }],
          template,
        );
      }
    } else {
      output += renderNodes(node.alternate, root, scopes, template);
    }
  }

  return output;
}

/** Render a Mini Template string with the supplied data. */
export function render(template: string, data: unknown): string {
  if (typeof template !== "string") {
    throw new TypeError("Template must be a string");
  }
  return renderNodes(parse(template), data, [], template);
}
