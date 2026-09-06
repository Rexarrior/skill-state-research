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
      alternate: Node[];
      location: Location;
    };

type BlockNode = Extract<Node, { type: "block" }>;

type Frame = {
  block: BlockNode;
  parent: Node[];
  inAlternate: boolean;
};

type Context = {
  root: unknown;
  current: unknown;
  index: number | undefined;
  hasCurrent: boolean;
};

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

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

function requirePath(path: string, tag: string, location: Location): string {
  if (!path) throw syntaxError(`${tag} requires a path`, location);
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
    if (open > cursor) current.push({ type: "text", value: template.slice(cursor, open) });

    const triple = template.startsWith("{{{", open);
    const closing = triple ? "}}}" : "}}";
    const contentStart = open + (triple ? 3 : 2);
    const close = template.indexOf(closing, contentStart);
    const location = locationAt(template, open);
    if (close === -1) throw syntaxError("Unclosed tag", location);

    const tag = template.slice(contentStart, close).trim();
    cursor = close + closing.length;

    if (triple) {
      current.push({
        type: "value",
        path: requirePath(tag, "Interpolation", location),
        escaped: false,
        location,
      });
      continue;
    }

    if (tag.startsWith("!")) continue;

    if (tag.startsWith("#")) {
      const match = /^#(\S+)(?:\s+(.*))?$/.exec(tag);
      const kind = match?.[1];
      if (kind !== "if" && kind !== "each") {
        throw syntaxError(`Unknown block ${kind ? `"${kind}"` : "tag"}`, location);
      }
      const block: BlockNode = {
        type: "block",
        kind,
        path: requirePath(match?.[2]?.trim() ?? "", `#${kind}`, location),
        body: [],
        alternate: [],
        location,
      };
      current.push(block);
      stack.push({ block, parent: current, inAlternate: false });
      current = block.body;
      continue;
    }

    if (tag === "else") {
      const frame = stack.at(-1);
      if (!frame) throw syntaxError("else outside a block", location);
      if (frame.inAlternate) throw syntaxError("Duplicate else", location);
      frame.inAlternate = true;
      current = frame.block.alternate;
      continue;
    }

    if (tag.startsWith("/")) {
      const closingKind = tag.slice(1).trim();
      const frame = stack.at(-1);
      if (!frame) throw syntaxError(`Unexpected closing block /${closingKind}`, location);
      if (closingKind !== frame.block.kind) {
        throw syntaxError(
          `Mismatched closing block /${closingKind}; expected /${frame.block.kind}`,
          location,
        );
      }
      stack.pop();
      current = frame.parent;
      continue;
    }

    current.push({
      type: "value",
      path: requirePath(tag, "Interpolation", location),
      escaped: true,
      location,
    });
  }

  const unclosed = stack.at(-1)?.block;
  if (unclosed) throw syntaxError(`Unclosed block #${unclosed.kind}`, unclosed.location);
  return root;
}

function readProperty(value: unknown, key: string): unknown {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    return undefined;
  }
  return Object.prototype.hasOwnProperty.call(value, key)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function follow(value: unknown, parts: string[]): unknown {
  for (const part of parts) value = readProperty(value, part);
  return value;
}

function resolve(path: string, context: Context): unknown {
  if (path === "this") return context.hasCurrent ? context.current : context.root;
  if (path.startsWith("this.")) {
    const base = context.hasCurrent ? context.current : context.root;
    return follow(base, path.slice(5).split("."));
  }
  if (path === "@index") return context.index;
  return follow(context.root, path.split("."));
}

function isTruthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (value === "" || value === false || value === null || value === undefined) return false;
  if (typeof value === "number" && value === 0) return false;
  if (typeof value === "bigint" && value === 0n) return false;
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

function renderNodes(nodes: Node[], context: Context): string {
  let output = "";
  for (const node of nodes) {
    if (node.type === "text") {
      output += node.value;
    } else if (node.type === "value") {
      const text = scalarText(resolve(node.path, context), node.path, node.location);
      output += node.escaped ? text.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]!) : text;
    } else if (node.kind === "if") {
      output += renderNodes(isTruthy(resolve(node.path, context)) ? node.body : node.alternate, context);
    } else {
      const value = resolve(node.path, context);
      if (!Array.isArray(value) || value.length === 0) {
        output += renderNodes(node.alternate, context);
      } else {
        for (let index = 0; index < value.length; index++) {
          output += renderNodes(node.body, {
            root: context.root,
            current: value[index],
            index,
            hasCurrent: true,
          });
        }
      }
    }
  }
  return output;
}

/** Render a Mini Template string with the supplied root data value. */
export function render(template: string, data: unknown): string {
  return renderNodes(parse(template), {
    root: data,
    current: undefined,
    index: undefined,
    hasCurrent: false,
  });
}
