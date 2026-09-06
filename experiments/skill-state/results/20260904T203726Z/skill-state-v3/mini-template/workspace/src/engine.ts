type TextNode = { type: "text"; value: string };
type ValueNode = { type: "value"; path: string; escaped: boolean };
type BlockNode = {
  type: "block";
  kind: "if" | "each";
  path: string;
  body: Node[];
  alternate: Node[];
  hasElse: boolean;
};
type Node = TextNode | ValueNode | BlockNode;

type Frame = { nodes: Node[]; block?: BlockNode };
type Context = { root: unknown; value: unknown; index?: number };

function location(source: string, offset: number): string {
  const before = source.slice(0, offset);
  const line = before.split("\n").length;
  const column = offset - before.lastIndexOf("\n");
  return `line ${line}, column ${column}`;
}

function syntaxError(source: string, offset: number, message: string): Error {
  return new Error(`${message} at ${location(source, offset)}`);
}

function parse(template: string): Node[] {
  const root: Node[] = [];
  const stack: Frame[] = [{ nodes: root }];
  let cursor = 0;

  while (cursor < template.length) {
    const start = template.indexOf("{{", cursor);
    if (start === -1) {
      stack.at(-1)!.nodes.push({ type: "text", value: template.slice(cursor) });
      break;
    }
    if (start > cursor) stack.at(-1)!.nodes.push({ type: "text", value: template.slice(cursor, start) });

    const triple = template.startsWith("{{{", start);
    const close = triple ? "}}}" : "}}";
    const end = template.indexOf(close, start + (triple ? 3 : 2));
    if (end === -1) throw syntaxError(template, start, "Unclosed tag");
    const content = template.slice(start + (triple ? 3 : 2), end).trim();
    const next = end + close.length;

    if (triple) {
      if (!content) throw syntaxError(template, start, "Empty interpolation");
      stack.at(-1)!.nodes.push({ type: "value", path: content, escaped: false });
    } else if (content.startsWith("!")) {
      // Comments deliberately have no node.
    } else if (content === "else") {
      const frame = stack.at(-1)!;
      if (!frame.block) throw syntaxError(template, start, "else outside a block");
      if (frame.block.hasElse) throw syntaxError(template, start, "Duplicate else");
      frame.block.hasElse = true;
      frame.nodes = frame.block.alternate;
    } else if (content.startsWith("#")) {
      const [kind, ...pathParts] = content.slice(1).trim().split(/\s+/);
      const path = pathParts.join(" ");
      if ((kind !== "if" && kind !== "each") || !path) {
        throw syntaxError(template, start, "Unknown or malformed block");
      }
      const block: BlockNode = { type: "block", kind, path, body: [], alternate: [], hasElse: false };
      stack.at(-1)!.nodes.push(block);
      stack.push({ nodes: block.body, block });
    } else if (content.startsWith("/")) {
      const kind = content.slice(1).trim();
      const frame = stack.at(-1)!;
      if (!frame.block) throw syntaxError(template, start, `Unexpected closing tag ${content}`);
      if (kind !== frame.block.kind) {
        throw syntaxError(template, start, `Mismatched closing tag ${content}; expected /${frame.block.kind}`);
      }
      stack.pop();
    } else {
      if (!content) throw syntaxError(template, start, "Empty interpolation");
      stack.at(-1)!.nodes.push({ type: "value", path: content, escaped: true });
    }
    cursor = next;
  }

  if (stack.length > 1) {
    const block = stack.at(-1)!.block!;
    throw syntaxError(template, template.length, `Unclosed block #${block.kind}`);
  }
  return root;
}

function lookup(path: string, context: Context): unknown {
  if (path === "this") return context.value;
  if (path === "@index") return context.index;
  const parts = path.split(".");
  let value: unknown = context.value;
  for (const part of parts) {
    if (value !== null && typeof value === "object" && part in value) {
      value = (value as Record<string, unknown>)[part];
    } else {
      value = undefined;
      break;
    }
  }
  if (value !== undefined || context.value === context.root) return value;
  value = context.root;
  for (const part of parts) {
    if (value !== null && typeof value === "object" && part in value) value = (value as Record<string, unknown>)[part];
    else return undefined;
  }
  return value;
}

function scalar(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  throw new Error(`Cannot render ${typeof value} as scalar text`);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

function truthy(value: unknown): boolean {
  return !(value === "" || value === 0 || value === false || value == null || (Array.isArray(value) && value.length === 0));
}

function renderNodes(nodes: Node[], context: Context): string {
  return nodes.map((node) => {
    if (node.type === "text") return node.value;
    if (node.type === "value") {
      const value = scalar(lookup(node.path, context));
      return node.escaped ? escapeHtml(value) : value;
    }
    const value = lookup(node.path, context);
    if (node.kind === "if") return renderNodes(truthy(value) ? node.body : node.alternate, context);
    if (!Array.isArray(value) || value.length === 0) return renderNodes(node.alternate, context);
    return value.map((item, index) => renderNodes(node.body, { root: context.root, value: item, index })).join("");
  }).join("");
}

/** Render a Mini Template string using the supplied root data object. */
export function render(template: string, data: unknown): string {
  return renderNodes(parse(template), { root: data, value: data });
}
