type Location = { line: number; column: number };
type Node =
  | { kind: "text"; text: string }
  | { kind: "value"; path: string; raw: boolean; at: Location }
  | { kind: "if" | "each"; path: string; body: Node[]; alternate: Node[]; at: Location };
type Block = Extract<Node, { body: Node[] }>;
type Context = { root: unknown; item?: unknown; index?: number; inLoop: boolean };

function fail(message: string, at: Location): never {
  throw new Error(`${message} at line ${at.line}, column ${at.column}`);
}

function validatePath(path: string, at: Location): string {
  if (!/^(?:@index|(?:this|[^\s.{}#/@!]+)(?:\.[^\s.{}#/@!]+)*)$/.test(path)) {
    fail(`Invalid path ${JSON.stringify(path)}`, at);
  }
  return path;
}

function parse(template: string): Node[] {
  const result: Node[] = [];
  const stack: { block: Block; parent: Node[]; hasElse: boolean }[] = [];
  let target = result;
  let offset = 0;
  let line = 1;
  let column = 1;
  function advance(end: number) {
    while (offset < end) {
      if (template[offset++] === "\n") { line++; column = 1; }
      else column++;
    }
  }
  while (offset < template.length) {
    const start = template.indexOf("{{", offset);
    if (start < 0) { target.push({ kind: "text", text: template.slice(offset) }); break; }
    if (start > offset) target.push({ kind: "text", text: template.slice(offset, start) });
    advance(start);
    const at = { line, column };
    const raw = template.startsWith("{{{", start);
    const openingLength = raw ? 3 : 2;
    const closing = raw ? "}}}" : "}}";
    const end = template.indexOf(closing, start + openingLength);
    if (end < 0) fail("Unclosed tag", at);
    const tag = template.slice(start + openingLength, end).trim();
    advance(end + closing.length);
    if (!raw && tag.startsWith("!")) continue;
    if (!raw && tag.startsWith("#")) {
      const match = /^#(\S+)(?:\s+([\s\S]*))?$/.exec(tag);
      const kind = match?.[1];
      if (kind !== "if" && kind !== "each") fail(`Unknown block ${JSON.stringify(kind ?? tag)}`, at);
      const path = validatePath(match?.[2]?.trim() ?? "", at);
      const block: Block = { kind, path, body: [], alternate: [], at };
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
      if (!frame) fail(`Unexpected closing tag ${tag}`, at);
      if (tag !== `/${frame.block.kind}`) fail(`Mismatched closing tag ${tag}; expected /${frame.block.kind}`, at);
      stack.pop();
      target = frame.parent;
    } else {
      target.push({ kind: "value", path: validatePath(tag, at), raw, at });
    }
  }
  const unclosed = stack[stack.length - 1];
  if (unclosed) fail(`Unclosed ${unclosed.block.kind} block`, unclosed.block.at);
  return result;
}

function lookup(value: unknown, parts: string[]): { found: boolean; value: unknown } {
  for (const part of parts) {
    if (value == null || !Object.prototype.hasOwnProperty.call(value, part)) return { found: false, value: undefined };
    value = (Object(value) as Record<string, unknown>)[part];
  }
  return { found: true, value };
}

function resolve(path: string, context: Context): unknown {
  if (path === "@index") return context.index;
  const parts = path.split(".");
  if (parts[0] === "this") return lookup(context.inLoop ? context.item : context.root, parts.slice(1)).value;
  if (context.inLoop) {
    const local = lookup(context.item, parts);
    if (local.found) return local.value;
  }
  return lookup(context.root, parts).value;
}

function truthy(value: unknown): boolean {
  return Array.isArray(value) ? value.length > 0 : Boolean(value);
}

function scalar(value: unknown, path: string, at: Location): string {
  if (value == null) return "";
  if (["string", "number", "boolean", "bigint", "symbol"].includes(typeof value)) return String(value);
  return fail(`Cannot render ${path}: expected a scalar value, received ${Array.isArray(value) ? "array" : typeof value}`, at);
}

const escapes: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

function renderNodes(nodes: Node[], context: Context, output: string[]): void {
  for (const node of nodes) {
    if (node.kind === "text") { output.push(node.text); continue; }
    const value = resolve(node.path, context);
    if (node.kind === "value") {
      const text = scalar(value, node.path, node.at);
      output.push(node.raw ? text : text.replace(/[&<>"']/g, character => escapes[character]!));
    } else if (node.kind === "if") {
      renderNodes(truthy(value) ? node.body : node.alternate, context, output);
    } else if (Array.isArray(value) && value.length > 0) {
      for (let index = 0; index < value.length; index++) {
        renderNodes(node.body, { root: context.root, item: value[index], index, inLoop: true }, output);
      }
    } else {
      renderNodes(node.alternate, context, output);
    }
  }
}

/** Render a template, throwing location-bearing errors for invalid syntax or non-scalar values. */
export function render(template: string, data: unknown): string {
  const output: string[] = [];
  renderNodes(parse(template), { root: data, inLoop: false }, output);
  return output.join("");
}
