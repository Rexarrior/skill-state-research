type Location = {
  line: number;
  column: number;
};

type TextNode = { type: "text"; value: string };
type ValueNode = {
  type: "value";
  path: string;
  escaped: boolean;
  location: Location;
};
type BlockNode = {
  type: "if" | "each";
  path: string;
  consequent: Node[];
  alternate: Node[];
  location: Location;
};
type Node = TextNode | ValueNode | BlockNode;

type Frame = {
  node: BlockNode | null;
  children: Node[];
  inElse: boolean;
};

type Context = {
  root: unknown;
  current: unknown;
  index: number | undefined;
};

const identifier = /^(?:this(?:\.[A-Za-z_$][\w$]*)*|@index|[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)$/;

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

function syntaxError(message: string, location: Location): Error {
  return new Error(`${message} at line ${location.line}, column ${location.column}`);
}

function validatePath(path: string, location: Location): void {
  if (!identifier.test(path)) {
    throw syntaxError(path ? `Invalid path "${path}"` : "Expected a path", location);
  }
}

function parse(template: string): Node[] {
  const root: Node[] = [];
  const stack: Frame[] = [{ node: null, children: root, inElse: false }];
  let cursor = 0;

  const currentFrame = (): Frame => stack[stack.length - 1]!;

  while (cursor < template.length) {
    const open = template.indexOf("{{", cursor);
    if (open === -1) {
      currentFrame().children.push({ type: "text", value: template.slice(cursor) });
      break;
    }

    if (open > cursor) {
      currentFrame().children.push({ type: "text", value: template.slice(cursor, open) });
    }

    const triple = template.startsWith("{{{", open);
    const closing = triple ? "}}}" : "}}";
    const contentStart = open + (triple ? 3 : 2);
    const close = template.indexOf(closing, contentStart);
    const location = locationAt(template, open);

    if (close === -1) {
      throw syntaxError("Unclosed tag", location);
    }

    const content = template.slice(contentStart, close).trim();
    cursor = close + closing.length;

    if (triple) {
      validatePath(content, location);
      currentFrame().children.push({ type: "value", path: content, escaped: false, location });
      continue;
    }

    if (content.startsWith("!")) continue;

    if (content === "else") {
      const frame = currentFrame();
      if (frame.node === null) throw syntaxError("else outside a block", location);
      if (frame.inElse) throw syntaxError("Duplicate else", location);
      frame.inElse = true;
      frame.children = frame.node.alternate;
      continue;
    }

    if (content.startsWith("#")) {
      const match = /^#([^\s]+)(?:\s+(.+))?$/.exec(content);
      const kind = match?.[1];
      const path = match?.[2]?.trim() ?? "";
      if (kind !== "if" && kind !== "each") {
        throw syntaxError(`Unknown block "${kind ?? content.slice(1)}"`, location);
      }
      validatePath(path, location);
      const node: BlockNode = {
        type: kind,
        path,
        consequent: [],
        alternate: [],
        location,
      };
      currentFrame().children.push(node);
      stack.push({ node, children: node.consequent, inElse: false });
      continue;
    }

    if (content.startsWith("/")) {
      const kind = content.slice(1).trim();
      const frame = currentFrame();
      if (frame.node === null) throw syntaxError(`Unexpected closing block "${kind}"`, location);
      if (kind !== frame.node.type) {
        throw syntaxError(`Mismatched closing block: expected /${frame.node.type}, got /${kind}`, location);
      }
      stack.pop();
      continue;
    }

    validatePath(content, location);
    currentFrame().children.push({ type: "value", path: content, escaped: true, location });
  }

  if (stack.length > 1) {
    const node = currentFrame().node!;
    throw syntaxError(`Unclosed block "${node.type}"`, node.location);
  }

  return root;
}

function readPath(value: unknown, parts: string[]): unknown {
  let result = value;
  for (const part of parts) {
    if (result === null || result === undefined) return undefined;
    if ((typeof result !== "object" && typeof result !== "function") || !(part in result)) {
      return undefined;
    }
    result = (result as Record<string, unknown>)[part];
  }
  return result;
}

function resolve(path: string, context: Context): unknown {
  if (path === "@index") return context.index;
  const parts = path.split(".");
  if (parts[0] === "this") return readPath(context.current, parts.slice(1));
  return readPath(context.root, parts);
}

function isTruthy(value: unknown): boolean {
  if (value === "" || value === 0 || value === false || value === null || value === undefined) return false;
  if (Array.isArray(value) && value.length === 0) return false;
  return true;
}

function scalarText(value: unknown, path: string, location: Location): string {
  if (value === null || value === undefined) return "";
  switch (typeof value) {
    case "string":
    case "number":
    case "bigint":
    case "boolean":
      return String(value);
    default:
      throw syntaxError(`Value at "${path}" is not scalar text`, location);
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

function renderNodes(nodes: Node[], context: Context): string {
  let output = "";
  for (const node of nodes) {
    if (node.type === "text") {
      output += node.value;
    } else if (node.type === "value") {
      const text = scalarText(resolve(node.path, context), node.path, node.location);
      output += node.escaped ? escapeHtml(text) : text;
    } else if (node.type === "if") {
      const branch = isTruthy(resolve(node.path, context)) ? node.consequent : node.alternate;
      output += renderNodes(branch, context);
    } else {
      const value = resolve(node.path, context);
      if (!Array.isArray(value) || value.length === 0) {
        output += renderNodes(node.alternate, context);
      } else {
        for (let index = 0; index < value.length; index++) {
          output += renderNodes(node.consequent, {
            root: context.root,
            current: value[index],
            index,
          });
        }
      }
    }
  }
  return output;
}

/** Render a Mini Template string with the supplied data. */
export function render(template: string, data: unknown): string {
  const nodes = parse(template);
  return renderNodes(nodes, { root: data, current: data, index: undefined });
}
