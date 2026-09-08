type Expression = { path: string; offset: number };
type Node =
  | { kind: "text"; value: string }
  | ({ kind: "value"; raw: boolean } & Expression)
  | ({ kind: "if" | "each"; body: Node[]; alternate: Node[] } & Expression);
type Block = Extract<Node, { kind: "if" | "each" }>;
type Context = { root: unknown; item?: unknown; index?: number };

/** Render a template. Invalid syntax and non-scalar interpolations throw. */
export function render(template: string, data: unknown): string {
  const fail = (message: string, offset: number): never => {
    const prefix = template.slice(0, offset);
    const line = prefix.split("\n").length;
    const column = offset - prefix.lastIndexOf("\n");
    throw new Error(`${message} at line ${line}, column ${column}`);
  };
  const expression = (path: string, offset: number): Expression => {
    if (!/^(?:@index|[^\s.{}#\/!]+)(?:\.[^\s.{}#\/!]+)*$/.test(path)) {
      fail(`Invalid path ${JSON.stringify(path)}`, offset);
    }
    return { path, offset };
  };
  const nodes: Node[] = [];
  const stack: { block: Block; parent: Node[]; hasElse: boolean }[] = [];
  let target = nodes;
  let cursor = 0;
  while (cursor < template.length) {
    const start = template.indexOf("{{", cursor);
    if (start < 0) {
      target.push({ kind: "text", value: template.slice(cursor) });
      break;
    }
    if (start > cursor) target.push({ kind: "text", value: template.slice(cursor, start) });
    const raw = template.startsWith("{{{", start);
    const openingLength = raw ? 3 : 2;
    const closing = raw ? "}}}" : "}}";
    const end = template.indexOf(closing, start + openingLength);
    if (end < 0) fail("Unclosed tag", start);
    const tag = template.slice(start + openingLength, end).trim();
    cursor = end + closing.length;
    if (!raw && tag.startsWith("!")) continue;
    if (!raw && tag.startsWith("#")) {
      const match = /^#(\S+)(?:\s+([\s\S]*))?$/.exec(tag);
      const kind = match?.[1];
      if (kind !== "if" && kind !== "each") fail(`Unknown block ${tag}`, start);
      const block: Block = {
        kind: kind as "if" | "each",
        ...expression(match?.[2]?.trim() ?? "", start),
        body: [], alternate: [],
      };
      target.push(block);
      stack.push({ block, parent: target, hasElse: false });
      target = block.body;
    } else if (!raw && tag === "else") {
      const frame = stack.at(-1);
      if (!frame) fail("else outside a block", start);
      if (frame!.hasElse) fail("Duplicate else", start);
      frame!.hasElse = true;
      target = frame!.block.alternate;
    } else if (!raw && tag.startsWith("/")) {
      const frame = stack.at(-1);
      if (!frame) fail(`Unexpected closing tag ${tag}`, start);
      if (tag !== `/${frame!.block.kind}`) {
        fail(`Mismatched closing tag ${tag}; expected /${frame!.block.kind}`, start);
      }
      target = frame!.parent;
      stack.pop();
    } else {
      target.push({ kind: "value", raw, ...expression(tag, start) });
    }
  }
  if (stack.length) {
    const block = stack.at(-1)!.block;
    fail(`Unclosed ${block.kind} block`, block.offset);
  }

  const output: string[] = [];
  const visit = (list: Node[], context: Context): void => {
    for (const node of list) {
      if (node.kind === "text") {
        output.push(node.value);
        continue;
      }
      const value = resolve(node.path, context);
      if (node.kind === "if") {
        visit(truthy(value) ? node.body : node.alternate, context);
      } else if (node.kind === "each") {
        if (Array.isArray(value) && value.length) {
          for (let index = 0; index < value.length; index++) {
            visit(node.body, { root: context.root, item: value[index], index });
          }
        } else {
          visit(node.alternate, context);
        }
      } else if (node.kind === "value") {
        if (value === null || value === undefined) continue;
        if (typeof value === "object" || typeof value === "function") {
          fail(`Cannot render non-scalar value at path ${JSON.stringify(node.path)}`, node.offset);
        }
        const text = String(value);
        output.push(node.raw ? text : escapeHtml(text));
      }
    }
  };
  visit(nodes, { root: data });
  return output.join("");
}

function lookup(value: unknown, segments: string[]): { found: boolean; value: unknown } {
  for (const segment of segments) {
    if (value === null || value === undefined || !Object.prototype.hasOwnProperty.call(value, segment)) {
      return { found: false, value: undefined };
    }
    value = (value as Record<string, unknown>)[segment];
  }
  return { found: true, value };
}

function resolve(path: string, context: Context): unknown {
  const segments = path.split(".");
  if (segments[0] === "this") {
    return lookup(context.index === undefined ? context.root : context.item, segments.slice(1)).value;
  }
  if (segments[0] === "@index") return lookup(context.index, segments.slice(1)).value;
  if (context.index !== undefined) {
    const local = lookup(context.item, segments);
    if (local.found) return local.value;
  }
  return lookup(context.root, segments).value;
}

function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return value !== "" && value !== 0 && value !== 0n && value !== false
    && value !== null && value !== undefined;
}

function escapeHtml(value: string): string {
  const entities: Record<string, string> = {
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  };
  return value.replace(/[&<>"']/g, character => entities[character]!);
}
