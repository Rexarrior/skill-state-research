type Position = { line: number; column: number };

type Node =
  | { kind: "text"; value: string }
  | { kind: "value"; path: string; escaped: boolean; position: Position }
  | {
      kind: "block";
      block: "if" | "each";
      path: string;
      body: Node[];
      alternative: Node[];
      position: Position;
    };

type BlockNode = Extract<Node, { kind: "block" }>;
type Frame = { node: BlockNode | null; nodes: Node[]; elseSeen: boolean };
type Context = { root: unknown; current: unknown; index?: number; inEach: boolean };

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

function requirePath(path: string, tag: string, position: Position): string {
  if (!path || path.split(".").some((part) => !part)) {
    throw syntaxError(`Invalid path in ${tag} tag`, position);
  }
  return path;
}

function parse(template: string): Node[] {
  const root: Node[] = [];
  const stack: Frame[] = [{ node: null, nodes: root, elseSeen: false }];
  let offset = 0;

  while (offset < template.length) {
    const open = template.indexOf("{{", offset);
    if (open < 0) {
      stack.at(-1)!.nodes.push({ kind: "text", value: template.slice(offset) });
      break;
    }
    if (open > offset) {
      stack.at(-1)!.nodes.push({ kind: "text", value: template.slice(offset, open) });
    }

    const triple = template.startsWith("{{{", open);
    const closeMarker = triple ? "}}}" : "}}";
    const contentStart = open + (triple ? 3 : 2);
    const close = template.indexOf(closeMarker, contentStart);
    const position = positionAt(template, open);
    if (close < 0) throw syntaxError("Unclosed tag", position);

    const content = template.slice(contentStart, close).trim();
    offset = close + closeMarker.length;
    const frame = stack.at(-1)!;

    if (triple) {
      frame.nodes.push({
        kind: "value",
        path: requirePath(content, "interpolation", position),
        escaped: false,
        position,
      });
      continue;
    }
    if (content.startsWith("!")) continue;

    if (content === "else") {
      if (!frame.node) throw syntaxError("else outside a block", position);
      if (frame.elseSeen) throw syntaxError("Duplicate else", position);
      frame.elseSeen = true;
      frame.nodes = frame.node.alternative;
      continue;
    }

    if (content.startsWith("#")) {
      const match = /^#(if|each)(?:\s+(.+))?$/.exec(content);
      if (!match) throw syntaxError(`Unknown or malformed block '${content}'`, position);
      const block = match[1] as "if" | "each";
      const node: BlockNode = {
        kind: "block",
        block,
        path: requirePath(match[2]?.trim() ?? "", `#${block}`, position),
        body: [],
        alternative: [],
        position,
      };
      frame.nodes.push(node);
      stack.push({ node, nodes: node.body, elseSeen: false });
      continue;
    }

    if (content.startsWith("/")) {
      const name = content.slice(1).trim();
      if (stack.length === 1) throw syntaxError(`Unexpected closing block '/${name}'`, position);
      if (name !== "if" && name !== "each") {
        throw syntaxError(`Unknown closing block '/${name}'`, position);
      }
      const expected = stack.at(-1)!.node!.block;
      if (name !== expected) {
        throw syntaxError(`Mismatched closing block '/${name}'; expected '/${expected}'`, position);
      }
      stack.pop();
      continue;
    }

    frame.nodes.push({
      kind: "value",
      path: requirePath(content, "interpolation", position),
      escaped: true,
      position,
    });
  }

  if (stack.length > 1) {
    const node = stack.at(-1)!.node!;
    throw syntaxError(`Unclosed #${node.block} block`, node.position);
  }
  return root;
}

function property(value: unknown, parts: string[]): { found: boolean; value: unknown } {
  let cursor = value;
  for (const part of parts) {
    if ((typeof cursor !== "object" || cursor === null) && typeof cursor !== "function") {
      return { found: false, value: undefined };
    }
    if (!Object.prototype.hasOwnProperty.call(cursor, part)) {
      return { found: false, value: undefined };
    }
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return { found: true, value: cursor };
}

function resolve(path: string, context: Context): unknown {
  if (path === "this") return context.inEach ? context.current : context.root;
  if (path === "@index") return context.inEach ? context.index : undefined;
  if (path.startsWith("this.")) {
    return property(context.inEach ? context.current : context.root, path.slice(5).split(".")).value;
  }
  if (path.startsWith("@index.")) return undefined;

  const parts = path.split(".");
  if (context.inEach) {
    const local = property(context.current, parts);
    if (local.found) return local.value;
  }
  return property(context.root, parts).value;
}

function isTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === "") return false;
  if ((typeof value === "number" || typeof value === "bigint") && value === 0) return false;
  if (Array.isArray(value) && value.length === 0) return false;
  return true;
}

function scalar(value: unknown, path: string, position: Position): string {
  if (value === null || value === undefined) return "";
  switch (typeof value) {
    case "string":
    case "number":
    case "bigint":
    case "boolean":
      return String(value);
    default:
      throw syntaxError(`Value at '${path}' is not scalar text`, position);
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

function renderNodes(nodes: Node[], context: Context): string {
  let output = "";
  for (const node of nodes) {
    if (node.kind === "text") {
      output += node.value;
    } else if (node.kind === "value") {
      const value = scalar(resolve(node.path, context), node.path, node.position);
      output += node.escaped ? escapeHtml(value) : value;
    } else if (node.block === "if") {
      output += renderNodes(isTruthy(resolve(node.path, context)) ? node.body : node.alternative, context);
    } else {
      const value = resolve(node.path, context);
      if (!Array.isArray(value) || value.length === 0) {
        output += renderNodes(node.alternative, context);
      } else {
        for (let index = 0; index < value.length; index++) {
          output += renderNodes(node.body, {
            root: context.root,
            current: value[index],
            index,
            inEach: true,
          });
        }
      }
    }
  }
  return output;
}

/** Render a Mini Template string with the supplied data. */
export function render(template: string, data: unknown): string {
  return renderNodes(parse(template), { root: data, current: data, inEach: false });
}
