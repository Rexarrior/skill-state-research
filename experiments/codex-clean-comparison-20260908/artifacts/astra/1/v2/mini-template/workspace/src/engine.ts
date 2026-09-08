type Location = { line: number; column: number };
type Node =
  | { kind: "text"; value: string }
  | { kind: "value"; path: string; raw: boolean; at: Location }
  | { kind: "if" | "each"; path: string; yes: Node[]; no: Node[]; at: Location };
type Block = Extract<Node, { kind: "if" | "each" }>;
type Context = { root: unknown; current: unknown; index?: number };

function fail(message: string, at: Location): never {
  throw new Error(`${message} at line ${at.line}, column ${at.column}`);
}

function checkPath(path: string, at: Location): void {
  if (!/^(?:@index|[^\s.{}#\/!@]+)(?:\.[^\s.{}#\/!@]+)*$/.test(path)) {
    fail(`Invalid path ${JSON.stringify(path)}`, at);
  }
}

function parse(template: string): Node[] {
  const result: Node[] = [];
  const stack: { block: Block; parent: Node[]; hasElse: boolean }[] = [];
  let output = result;
  let cursor = 0;
  let line = 1;
  let column = 1;
  const advance = (end: number) => {
    for (; cursor < end; cursor++) {
      if (template[cursor] === "\n") { line++; column = 1; }
      else column++;
    }
  };
  while (cursor < template.length) {
    const start = template.indexOf("{{", cursor);
    if (start < 0) {
      output.push({ kind: "text", value: template.slice(cursor) });
      break;
    }
    if (start > cursor) output.push({ kind: "text", value: template.slice(cursor, start) });
    advance(start);
    const at = { line, column };
    const raw = template.startsWith("{{{", start);
    const opening = raw ? 3 : 2;
    const closing = raw ? "}}}" : "}}";
    const end = template.indexOf(closing, start + opening);
    if (end < 0) fail("Unclosed tag", at);
    const tag = template.slice(start + opening, end).trim();
    advance(end + closing.length);
    if (!raw && tag.startsWith("!")) continue;
    if (!raw && tag.startsWith("#")) {
      const match = /^#(\S+)(?:\s+([\s\S]*))?$/.exec(tag);
      const name = match?.[1];
      if (name !== "if" && name !== "each") fail(`Unknown block ${JSON.stringify(name ?? tag)}`, at);
      const path = match?.[2]?.trim() ?? "";
      checkPath(path, at);
      const block: Block = { kind: name, path, yes: [], no: [], at };
      output.push(block);
      stack.push({ block, parent: output, hasElse: false });
      output = block.yes;
    } else if (!raw && tag === "else") {
      const frame = stack[stack.length - 1];
      if (!frame) fail("else outside a block", at);
      if (frame.hasElse) fail("Duplicate else", at);
      frame.hasElse = true;
      output = frame.block.no;
    } else if (!raw && tag.startsWith("/")) {
      const name = tag.slice(1).trim();
      const frame = stack[stack.length - 1];
      if (!frame) fail(`Unexpected closing block ${JSON.stringify(name)}`, at);
      if (name !== frame.block.kind) fail(`Mismatched closing block ${JSON.stringify(name)}; expected /${frame.block.kind}`, at);
      stack.pop();
      output = frame.parent;
    } else {
      checkPath(tag, at);
      output.push({ kind: "value", path: tag, raw, at });
    }
  }
  if (stack.length) {
    const block = stack[stack.length - 1]!.block;
    fail(`Unclosed ${block.kind} block`, block.at);
  }
  return result;
}

const missing = Symbol("missing");
function lookup(value: unknown, parts: string[]): unknown {
  for (const part of parts) {
    if (value == null || !Object.prototype.hasOwnProperty.call(value, part)) return missing;
    value = (Object(value) as Record<string, unknown>)[part];
  }
  return value;
}

function resolve(path: string, context: Context): unknown {
  const parts = path.split(".");
  if (parts[0] === "this") return lookup(context.current, parts.slice(1));
  if (parts[0] === "@index") return lookup(context.index, parts.slice(1));
  const local = lookup(context.current, parts);
  return local === missing ? lookup(context.root, parts) : local;
}

function truthy(value: unknown): boolean {
  return value !== missing && value !== undefined && value !== null
    && value !== false && value !== "" && value !== 0 && value !== 0n
    && (!Array.isArray(value) || value.length > 0);
}

function scalar(value: unknown, path: string, at: Location): string {
  if (value === missing || value == null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  fail(`Cannot render non-scalar value at path ${JSON.stringify(path)} (${Array.isArray(value) ? "array" : typeof value})`, at);
}

const entities: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
function evaluate(nodes: Node[], context: Context): string {
  const chunks: string[] = [];
  for (const node of nodes) {
    if (node.kind === "text") { chunks.push(node.value); continue; }
    const value = resolve(node.path, context);
    if (node.kind === "value") {
      const text = scalar(value, node.path, node.at);
      chunks.push(node.raw ? text : text.replace(/[&<>"']/g, char => entities[char]!));
    } else if (node.kind === "if") {
      chunks.push(evaluate(truthy(value) ? node.yes : node.no, context));
    } else if (Array.isArray(value) && value.length > 0) {
      for (let index = 0; index < value.length; index++) {
        chunks.push(evaluate(node.yes, { root: context.root, current: value[index], index }));
      }
    } else {
      chunks.push(evaluate(node.no, context));
    }
  }
  return chunks.join("");
}

/** Render a template; syntax and non-scalar interpolation errors include source locations. */
export function render(template: string, data: unknown): string {
  return evaluate(parse(template), { root: data, current: data });
}
