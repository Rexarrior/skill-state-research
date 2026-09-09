type Position = { line: number; column: number };
type TextNode = { kind: "text"; text: string };
type ValueNode = { kind: "value"; path: string; raw: boolean; at: Position };
type BlockNode = {
  kind: "if" | "each";
  path: string;
  body: Node[];
  alternate: Node[];
  at: Position;
};
type Node = TextNode | ValueNode | BlockNode;
type Frame = { block: BlockNode; parent: Node[]; hasElse: boolean };
type Context = { root: unknown; item?: unknown; index?: number };

function fail(message: string, at: Position): never {
  throw new Error(`${message} at line ${at.line}, column ${at.column}`);
}

function parse(template: string): Node[] {
  const nodes: Node[] = [];
  const stack: Frame[] = [];
  let target = nodes;
  let offset = 0;
  let line = 1;
  let column = 1;

  function advance(end: number): void {
    while (offset < end) {
      if (template[offset++] === "\n") {
        line++;
        column = 1;
      } else {
        column++;
      }
    }
  }

  function path(value: string, at: Position): string {
    if (!value || value.split(".").some(part => !part || /[\s{}]/u.test(part))) {
      fail("Expected a non-empty dotted path", at);
    }
    return value;
  }

  while (offset < template.length) {
    const start = template.indexOf("{{", offset);
    if (start === -1) {
      target.push({ kind: "text", text: template.slice(offset) });
      break;
    }
    if (start > offset) target.push({ kind: "text", text: template.slice(offset, start) });
    advance(start);
    const at = { line, column };
    const raw = template.startsWith("{{{", start);
    const opening = raw ? 3 : 2;
    const closing = raw ? "}}}" : "}}";
    const end = template.indexOf(closing, start + opening);
    if (end === -1) fail("Unclosed tag", at);
    const tag = template.slice(start + opening, end).trim();
    advance(end + closing.length);

    if (!raw && tag.startsWith("!")) continue;
    if (!raw && tag.startsWith("#")) {
      const match = /^#(\S+)(?:\s+([\s\S]*))?$/u.exec(tag);
      const name = match?.[1];
      if (name !== "if" && name !== "each") fail(`Unknown block '${name ?? tag}'`, at);
      const block: BlockNode = {
        kind: name, path: path(match?.[2]?.trim() ?? "", at), body: [], alternate: [], at,
      };
      target.push(block);
      stack.push({ block, parent: target, hasElse: false });
      target = block.body;
    } else if (!raw && tag === "else") {
      const frame = stack[stack.length - 1];
      if (!frame) fail("Unexpected else outside a block", at);
      if (frame.hasElse) fail("Duplicate else", at);
      frame.hasElse = true;
      target = frame.block.alternate;
    } else if (!raw && tag.startsWith("/")) {
      const name = tag.slice(1).trim();
      const frame = stack[stack.length - 1];
      if (!frame) fail(`Unexpected closing block '${name}'`, at);
      if (name !== frame.block.kind) {
        fail(`Mismatched closing block '${name}'; expected '${frame.block.kind}'`, at);
      }
      stack.pop();
      target = frame.parent;
    } else {
      target.push({ kind: "value", path: path(tag, at), raw, at });
    }
  }
  const frame = stack[stack.length - 1];
  if (frame) fail(`Unclosed block '${frame.block.kind}'`, frame.block.at);
  return nodes;
}

// Own properties keep prototype members from becoming template data.
function lookup(value: unknown, parts: string[]): { found: boolean; value: unknown } {
  for (const part of parts) {
    if (value == null || !Object.prototype.hasOwnProperty.call(value, part)) {
      return { found: false, value: undefined };
    }
    value = (value as Record<string, unknown>)[part];
  }
  return { found: true, value };
}

function resolve(path: string, context: Context): unknown {
  const parts = path.split(".");
  if (parts[0] === "this") {
    return lookup(context.index === undefined ? context.root : context.item, parts.slice(1)).value;
  }
  if (parts[0] === "@index") return parts.length === 1 ? context.index : undefined;
  if (context.index !== undefined) {
    const local = lookup(context.item, parts);
    if (local.found) return local.value;
  }
  return lookup(context.root, parts).value;
}

function truthy(value: unknown): boolean {
  return Boolean(value) && (!Array.isArray(value) || value.length > 0);
}

const escapes: Record<string, string> = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
};

function scalar(value: unknown, node: ValueNode): string {
  if (value == null) return "";
  if (typeof value === "object" || typeof value === "function") {
    fail(`Cannot render '${node.path}' as scalar text (${Array.isArray(value) ? "array" : typeof value})`, node.at);
  }
  const text = String(value);
  return node.raw ? text : text.replace(/[&<>"']/g, character => escapes[character]!);
}

/** Render a template using own-property paths and HTML escaping by default. */
export function render(template: string, data: unknown): string {
  const nodes = parse(template);
  const output: string[] = [];
  function visit(nodes: Node[], context: Context): void {
    for (const node of nodes) {
      if (node.kind === "text") {
        output.push(node.text);
      } else if (node.kind === "value") {
        output.push(scalar(resolve(node.path, context), node));
      } else {
        const value = resolve(node.path, context);
        if (node.kind === "if") {
          visit(truthy(value) ? node.body : node.alternate, context);
        } else if (Array.isArray(value) && value.length > 0) {
          for (let index = 0; index < value.length; index++) {
            visit(node.body, { root: context.root, item: value[index], index });
          }
        } else {
          visit(node.alternate, context);
        }
      }
    }
  }
  visit(nodes, { root: data });
  return output.join("");
}
