type Position = { line: number; column: number };

type TextNode = { kind: "text"; value: string };
type ValueNode = { kind: "value"; path: string; escaped: boolean; position: Position };
type BlockNode = {
  kind: "if" | "each";
  path: string;
  truthy: Node[];
  falsy: Node[];
  position: Position;
};
type Node = TextNode | ValueNode | BlockNode;

type Frame = {
  block: BlockNode;
  parent: Node[];
  inElse: boolean;
};

type Context = {
  root: unknown;
  current: unknown;
  index: number | undefined;
};

function fail(message: string, position: Position): never {
  throw new Error(`${message} at line ${position.line}, column ${position.column}`);
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

function requirePath(path: string, tag: string, position: Position): string {
  if (!path) fail(`${tag} requires a path`, position);
  return path;
}

function parse(template: string): Node[] {
  const root: Node[] = [];
  let output = root;
  const stack: Frame[] = [];
  let cursor = 0;

  while (cursor < template.length) {
    const open = template.indexOf("{{", cursor);
    if (open === -1) {
      output.push({ kind: "text", value: template.slice(cursor) });
      break;
    }
    if (open > cursor) output.push({ kind: "text", value: template.slice(cursor, open) });

    const position = positionAt(template, open);
    const triple = template.startsWith("{{{", open);
    const closeToken = triple ? "}}}" : "}}";
    const contentStart = open + (triple ? 3 : 2);
    const close = template.indexOf(closeToken, contentStart);
    if (close === -1) fail("Unclosed tag", position);

    const content = template.slice(contentStart, close).trim();
    cursor = close + closeToken.length;

    if (triple) {
      output.push({
        kind: "value",
        path: requirePath(content, "Interpolation", position),
        escaped: false,
        position,
      });
      continue;
    }

    if (content.startsWith("!")) continue;

    if (content.startsWith("#")) {
      const match = /^#([^\s]+)(?:\s+(.*))?$/.exec(content);
      const name = match?.[1] ?? "";
      if (name !== "if" && name !== "each") fail(`Unknown block '${name}'`, position);
      const block: BlockNode = {
        kind: name,
        path: requirePath(match?.[2]?.trim() ?? "", `#${name}`, position),
        truthy: [],
        falsy: [],
        position,
      };
      output.push(block);
      stack.push({ block, parent: output, inElse: false });
      output = block.truthy;
      continue;
    }

    if (content === "else") {
      const frame = stack.at(-1);
      if (!frame) fail("else outside a block", position);
      if (frame.inElse) fail("Duplicate else", position);
      frame.inElse = true;
      output = frame.block.falsy;
      continue;
    }

    if (content.startsWith("/")) {
      const name = content.slice(1).trim();
      const frame = stack.at(-1);
      if (!frame) fail(`Closing block '/${name}' without an open block`, position);
      if (name !== "if" && name !== "each") fail(`Unknown closing block '/${name}'`, position);
      if (frame.block.kind !== name) {
        fail(`Mismatched closing block '/${name}'; expected '/${frame.block.kind}'`, position);
      }
      stack.pop();
      output = frame.parent;
      continue;
    }

    output.push({
      kind: "value",
      path: requirePath(content, "Interpolation", position),
      escaped: true,
      position,
    });
  }

  const unclosed = stack.at(-1)?.block;
  if (unclosed) fail(`Unclosed block '#${unclosed.kind}'`, unclosed.position);
  return root;
}

function property(value: unknown, key: string): unknown {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") {
    return undefined;
  }
  return Object.prototype.hasOwnProperty.call(value, key)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function traverse(value: unknown, parts: string[]): unknown {
  for (const part of parts) {
    value = property(value, part);
    if (value === undefined) break;
  }
  return value;
}

function resolve(path: string, context: Context): unknown {
  if (path === "this") return context.current;
  if (path === "@index") return context.index;

  if (path.startsWith("this.")) return traverse(context.current, path.slice(5).split("."));
  if (path.startsWith("@index.")) return undefined;

  const parts = path.split(".");
  const local = traverse(context.current, parts);
  return local === undefined && context.current !== context.root
    ? traverse(context.root, parts)
    : local;
}

function isTruthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return value !== "" && value !== 0 && value !== false && value !== null && value !== undefined;
}

function scalar(value: unknown, path: string, position: Position): string {
  if (value === null || value === undefined) return "";
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }
  fail(`Value '${path}' is not renderable as scalar text (received ${typeof value})`, position);
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
    if (node.kind === "value") {
      const text = scalar(resolve(node.path, context), node.path, node.position);
      result += node.escaped ? escapeHtml(text) : text;
      continue;
    }

    const value = resolve(node.path, context);
    if (node.kind === "if") {
      result += renderNodes(isTruthy(value) ? node.truthy : node.falsy, context);
    } else if (Array.isArray(value) && value.length > 0) {
      for (let index = 0; index < value.length; index++) {
        result += renderNodes(node.truthy, {
          root: context.root,
          current: value[index],
          index,
        });
      }
    } else {
      result += renderNodes(node.falsy, context);
    }
  }
  return result;
}

/** Render a Mini Template string with the supplied data. */
export function render(template: string, data: unknown): string {
  return renderNodes(parse(template), { root: data, current: data, index: undefined });
}
