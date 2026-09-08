type Location = { line: number; column: number };
type Path = { text: string; parts: string[] };
type Node =
  | { kind: "text"; text: string }
  | { kind: "value"; path: Path; raw: boolean; at: Location }
  | { kind: "if" | "each"; path: Path; body: Node[]; alternate: Node[]; at: Location };
type Block = Extract<Node, { kind: "if" | "each" }>;

function fail(message: string, at: Location): never {
  throw new Error(`${message} at line ${at.line}, column ${at.column}`);
}

function parsePath(text: string, at: Location): Path {
  if (!text || /\s|[{}]/.test(text) || text.split(".").some(part => !part)) {
    fail(`Invalid path ${JSON.stringify(text)}`, at);
  }
  return { text, parts: text.split(".") };
}

function parse(template: string): Node[] {
  const root: Node[] = [];
  const stack: { block: Block; hasElse: boolean }[] = [];
  let target = root;
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
    if (start < 0) { target.push({ kind: "text", text: template.slice(cursor) }); break; }
    if (start > cursor) target.push({ kind: "text", text: template.slice(cursor, start) });
    advance(start);
    const at = { line, column };
    const raw = template.startsWith("{{{", start);
    const close = raw ? "}}}" : "}}";
    const end = template.indexOf(close, start + (raw ? 3 : 2));
    if (end < 0) fail("Unclosed tag", at);
    const tag = template.slice(start + (raw ? 3 : 2), end).trim();
    advance(end + close.length);
    if (!raw && tag.startsWith("!")) continue;
    if (!raw && tag.startsWith("#")) {
      const match = /^#(\S+)(?:\s+([\s\S]*))?$/.exec(tag);
      const kind = match?.[1];
      if (kind !== "if" && kind !== "each") fail(`Unknown block ${JSON.stringify(kind ?? tag)}`, at);
      const block: Block = { kind, path: parsePath(match?.[2] ?? "", at), body: [], alternate: [], at };
      target.push(block);
      stack.push({ block, hasElse: false });
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
      const parent = stack[stack.length - 1];
      target = parent ? (parent.hasElse ? parent.block.alternate : parent.block.body) : root;
    } else {
      target.push({ kind: "value", path: parsePath(tag, at), raw, at });
    }
  }
  if (stack.length) {
    const { block } = stack[stack.length - 1];
    fail(`Unclosed ${block.kind} block`, block.at);
  }
  return root;
}

const missing = Symbol("missing");
type Context = { item: unknown; index: number };
function lookup(value: unknown, parts: string[]): unknown | typeof missing {
  for (const part of parts) {
    if (value == null || !Object.prototype.hasOwnProperty.call(value, part)) return missing;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}
function resolve(path: Path, root: unknown, context?: Context): unknown {
  const [first, ...rest] = path.parts;
  let value: unknown;
  if (first === "this") value = lookup(context ? context.item : root, rest);
  else if (first === "@index") value = context ? lookup(context.index, rest) : missing;
  else {
    value = context ? lookup(context.item, path.parts) : missing;
    if (value === missing) value = lookup(root, path.parts);
  }
  return value === missing ? undefined : value;
}
function truthy(value: unknown): boolean {
  return value !== "" && value !== 0 && value !== 0n && value !== false && value != null
    && (!Array.isArray(value) || value.length > 0);
}
function scalar(value: unknown, path: Path, at: Location): string {
  if (value == null) return "";
  if (["string", "number", "boolean", "bigint"].includes(typeof value)) return String(value);
  fail(`Cannot render non-scalar value for path ${JSON.stringify(path.text)} (${Array.isArray(value) ? "array" : typeof value})`, at);
}
const escapes: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Render a template with escaped values, conditionals, and array iteration. */
export function render(template: string, data: unknown): string {
  const nodes = parse(template);
  const output: string[] = [];
  function visit(nodes: Node[], context?: Context): void {
    for (const node of nodes) {
      if (node.kind === "text") { output.push(node.text); continue; }
      const value = resolve(node.path, data, context);
      if (node.kind === "value") {
        const text = scalar(value, node.path, node.at);
        output.push(node.raw ? text : text.replace(/[&<>"']/g, char => escapes[char]!));
      } else if (node.kind === "if") {
        visit(truthy(value) ? node.body : node.alternate, context);
      } else if (Array.isArray(value) && value.length) {
        for (let index = 0; index < value.length; index++) visit(node.body, { item: value[index], index });
      } else visit(node.alternate, context);
    }
  }
  visit(nodes);
  return output.join("");
}
