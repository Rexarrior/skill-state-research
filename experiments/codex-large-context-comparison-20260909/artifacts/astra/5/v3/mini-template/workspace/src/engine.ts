type Location = { line: number; column: number };
type Node =
  | { kind: "text"; value: string }
  | { kind: "value"; path: string; raw: boolean; at: Location }
  | { kind: "if" | "each"; path: string; body: Node[]; alternate: Node[]; at: Location };
type Block = Extract<Node, { kind: "if" | "each" }>;

function fail(message: string, at: Location): never {
  throw new Error(`${message} at line ${at.line}, column ${at.column}`);
}

function parse(template: string): Node[] {
  const result: Node[] = [];
  const stack: { block: Block; parent: Node[]; hasElse: boolean }[] = [];
  let target = result;
  let cursor = 0;
  let line = 1;
  let column = 1;
  function advance(end: number) {
    while (cursor < end) {
      if (template[cursor++] === "\n") { line++; column = 1; }
      else column++;
    }
  }
  while (cursor < template.length) {
    const start = template.indexOf("{{", cursor);
    if (start === -1) {
      target.push({ kind: "text", value: template.slice(cursor) });
      break;
    }
    if (start > cursor) target.push({ kind: "text", value: template.slice(cursor, start) });
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
      const match = /^#(if|each)\s+(.+)$/.exec(tag);
      if (!match) fail(`Unknown or malformed block '${tag}'`, at);
      const block: Block = { kind: match[1] as "if" | "each", path: match[2].trim(), body: [], alternate: [], at };
      target.push(block);
      stack.push({ block, parent: target, hasElse: false });
      target = block.body;
    } else if (!raw && tag === "else") {
      const frame = stack[stack.length - 1];
      if (!frame) fail("else outside a block", at);
      if (frame.hasElse) fail("Duplicate else", at);
      frame.hasElse = true;
      target = frame.block.alternate;
    } else if (!raw && tag.startsWith("/")) {
      const frame = stack[stack.length - 1];
      if (!frame) fail(`Unexpected close '${tag}'`, at);
      if (tag !== `/${frame.block.kind}`) fail(`Mismatched close '${tag}'; expected '/${frame.block.kind}'`, at);
      stack.pop();
      target = frame.parent;
    } else {
      if (!tag) fail("Empty interpolation", at);
      target.push({ kind: "value", path: tag, raw, at });
    }
  }
  if (stack.length) {
    const { block } = stack[stack.length - 1];
    fail(`Unclosed '${block.kind}' block`, block.at);
  }
  return result;
}

type Context = { root: unknown; item?: unknown; index?: number; inLoop: boolean };
const missing = Symbol("missing");
function lookup(value: unknown, parts: string[]): unknown {
  for (const part of parts) {
    if (value == null || !Object.prototype.hasOwnProperty.call(value, part)) return missing;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}
function resolve(path: string, context: Context): unknown {
  const parts = path.split(".");
  if (parts[0] === "this") return lookup(context.inLoop ? context.item : context.root, parts.slice(1));
  if (parts[0] === "@index") return lookup(context.index, parts.slice(1));
  if (context.inLoop) {
    const local = lookup(context.item, parts);
    if (local !== missing) return local;
  }
  return lookup(context.root, parts);
}
function truthy(value: unknown): boolean {
  return value !== missing && Boolean(value) && (!Array.isArray(value) || value.length > 0);
}
function scalar(value: unknown, path: string, at: Location): string {
  if (value === missing || value == null) return "";
  if (["string", "number", "boolean", "bigint"].includes(typeof value)) return String(value);
  return fail(`Cannot render '${path}' as scalar text (${Array.isArray(value) ? "array" : typeof value})`, at);
}
const escapes: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
function evaluate(nodes: Node[], context: Context, output: string[]): void {
  for (const node of nodes) {
    if (node.kind === "text") { output.push(node.value); continue; }
    const value = resolve(node.path, context);
    if (node.kind === "value") {
      const text = scalar(value, node.path, node.at);
      output.push(node.raw ? text : text.replace(/[&<>"']/g, character => escapes[character]));
    } else if (node.kind === "if") {
      evaluate(truthy(value) ? node.body : node.alternate, context, output);
    } else if (Array.isArray(value) && value.length > 0) {
      for (let index = 0; index < value.length; index++) {
        evaluate(node.body, { root: context.root, item: value[index], index, inLoop: true }, output);
      }
    } else evaluate(node.alternate, context, output);
  }
}

/** Render a template, throwing a located error for invalid structure or non-scalar output. */
export function render(template: string, data: unknown): string {
  const nodes = parse(template);
  const output: string[] = [];
  evaluate(nodes, { root: data, inLoop: false }, output);
  return output.join("");
}
