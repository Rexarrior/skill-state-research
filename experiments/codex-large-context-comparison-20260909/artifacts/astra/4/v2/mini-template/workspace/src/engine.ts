type Location = { line: number; column: number };
type TextNode = { kind: "text"; text: string };
type ValueNode = { kind: "value"; path: string; raw: boolean; at: Location };
type BlockNode = {
  kind: "if" | "each";
  path: string;
  body: Node[];
  otherwise: Node[];
  at: Location;
};
type Node = TextNode | ValueNode | BlockNode;
type Frame = { block: BlockNode; parent: Node[]; hasElse: boolean };
type Context = { root: unknown; item: unknown; index?: number };

function fail(message: string, at: Location): never {
  throw new Error(`${message} (line ${at.line}, column ${at.column})`);
}

function validatePath(path: string, at: Location): string {
  if (!/^(?:@index|[^\s.{}#\/!@]+)(?:\.[^\s.{}#\/!@]+)*$/.test(path)) {
    fail(`Invalid path: ${JSON.stringify(path)}`, at);
  }
  return path;
}

function parse(template: string): Node[] {
  const result: Node[] = [];
  const stack: Frame[] = [];
  let target = result;
  let offset = 0;
  let line = 1;
  let column = 1;
  function advance(end: number) {
    for (; offset < end; offset++) {
      if (template[offset] === "\n") { line++; column = 1; }
      else column++;
    }
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
    const opener = raw ? 3 : 2;
    const closer = raw ? "}}}" : "}}";
    const end = template.indexOf(closer, start + opener);
    if (end === -1) fail("Unclosed tag", at);
    const tag = template.slice(start + opener, end).trim();
    advance(end + closer.length);
    if (!raw && tag.startsWith("!")) continue;
    if (!raw && tag.startsWith("#")) {
      const match = /^#(\S+)(?:\s+([\s\S]*))?$/.exec(tag);
      const name = match?.[1];
      if (name !== "if" && name !== "each") fail(`Unknown block: ${name ?? tag}`, at);
      const path = validatePath(match?.[2]?.trim() ?? "", at);
      const block: BlockNode = { kind: name, path, body: [], otherwise: [], at };
      target.push(block);
      stack.push({ block, parent: target, hasElse: false });
      target = block.body;
    } else if (!raw && tag === "else") {
      const frame = stack[stack.length - 1];
      if (!frame) fail("else outside a block", at);
      if (frame.hasElse) fail("Duplicate else", at);
      frame.hasElse = true;
      target = frame.block.otherwise;
    } else if (!raw && tag.startsWith("/")) {
      const name = tag.slice(1).trim();
      const frame = stack[stack.length - 1];
      if (!frame) fail(`Unexpected closing tag: ${tag}`, at);
      if (name !== frame.block.kind) fail(`Mismatched closing tag: expected /${frame.block.kind}, got ${tag}`, at);
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

const missing = Symbol("missing");
function lookup(value: unknown, parts: string[]): unknown | typeof missing {
  for (const part of parts) {
    if (value == null || !Object.prototype.hasOwnProperty.call(value, part)) return missing;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

function resolve(path: string, context: Context): unknown {
  const parts = path.split(".");
  if (parts[0] === "@index") return parts.length === 1 ? context.index : undefined;
  if (parts[0] === "this") {
    const value = lookup(context.item, parts.slice(1));
    return value === missing ? undefined : value;
  }
  const local = lookup(context.item, parts);
  if (local !== missing) return local;
  const root = lookup(context.root, parts);
  return root === missing ? undefined : root;
}

function truthy(value: unknown): boolean {
  return Array.isArray(value) ? value.length > 0 : Boolean(value);
}

const escapes: Record<string, string> = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
};
function scalar(value: unknown, path: string, at: Location): string {
  if (value == null) return "";
  switch (typeof value) {
    case "string": case "number": case "boolean": case "bigint": return String(value);
    default: return fail(`Cannot render ${path}: expected scalar text, received ${Array.isArray(value) ? "array" : typeof value}`, at);
  }
}

/** Render a template with HTML escaping, conditionals, and array iteration. */
export function render(template: string, data: unknown): string {
  const nodes = parse(template);
  const output: string[] = [];
  function visit(nodes: Node[], context: Context): void {
    for (const node of nodes) {
      if (node.kind === "text") { output.push(node.text); continue; }
      const value = resolve(node.path, context);
      if (node.kind === "value") {
        const text = scalar(value, node.path, node.at);
        output.push(node.raw ? text : text.replace(/[&<>"']/g, character => escapes[character]!));
      } else if (node.kind === "if") {
        visit(truthy(value) ? node.body : node.otherwise, context);
      } else if (Array.isArray(value) && value.length > 0) {
        for (let index = 0; index < value.length; index++) {
          visit(node.body, { root: context.root, item: value[index], index });
        }
      } else {
        visit(node.otherwise, context);
      }
    }
  }
  visit(nodes, { root: data, item: data });
  return output.join("");
}
