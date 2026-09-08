type Position = { line: number; column: number };
type Node =
  | { kind: "text"; value: string }
  | { kind: "value"; path: string; raw: boolean; at: Position }
  | { kind: "if" | "each"; path: string; yes: Node[]; no: Node[]; at: Position };
type Block = Extract<Node, { kind: "if" | "each" }>;

function fail(message: string, at: Position): never {
  throw new Error(`${message} at line ${at.line}, column ${at.column}`);
}

function validatePath(path: string, at: Position): string {
  if (!/^(?:@index|[^\s.{}#/@!]+)(?:\.[^\s.{}#/@!]+)*$/.test(path)) {
    fail(`Invalid path ${JSON.stringify(path)}`, at);
  }
  return path;
}

function parse(template: string): Node[] {
  const result: Node[] = [];
  const stack: { node: Block; parent: Node[]; hasElse: boolean }[] = [];
  let nodes = result;
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
      nodes.push({ kind: "text", value: template.slice(offset) });
      break;
    }
    if (start > offset) nodes.push({ kind: "text", value: template.slice(offset, start) });
    advance(start);
    const at = { line, column };
    const raw = template.startsWith("{{{", start);
    const openLength = raw ? 3 : 2;
    const close = raw ? "}}}" : "}}";
    const end = template.indexOf(close, start + openLength);
    if (end === -1) fail("Unclosed tag", at);
    const tag = template.slice(start + openLength, end).trim();
    advance(end + close.length);
    if (!raw && tag.startsWith("!")) continue;
    if (!raw && tag.startsWith("#")) {
      const match = /^#(\S+)(?:\s+(.+))?$/.exec(tag);
      const kind = match?.[1];
      if (kind !== "if" && kind !== "each") fail(`Unknown block ${JSON.stringify(kind ?? tag)}`, at);
      const path = validatePath(match?.[2]?.trim() ?? "", at);
      const node: Block = { kind, path, yes: [], no: [], at };
      nodes.push(node);
      stack.push({ node, parent: nodes, hasElse: false });
      nodes = node.yes;
    } else if (!raw && tag === "else") {
      const frame = stack[stack.length - 1];
      if (!frame) fail("else outside a block", at);
      if (frame.hasElse) fail("Duplicate else", at);
      frame.hasElse = true;
      nodes = frame.node.no;
    } else if (!raw && tag.startsWith("/")) {
      const frame = stack[stack.length - 1];
      if (!frame) fail(`Unexpected closing tag ${tag}`, at);
      if (tag !== `/${frame.node.kind}`) fail(`Mismatched closing tag ${tag}; expected /${frame.node.kind}`, at);
      stack.pop();
      nodes = frame.parent;
    } else {
      nodes.push({ kind: "value", path: validatePath(tag, at), raw, at });
    }
  }
  const unclosed = stack[stack.length - 1];
  if (unclosed) fail(`Unclosed ${unclosed.node.kind} block`, unclosed.node.at);
  return result;
}

const MISSING = Symbol("missing");
type Context = { root: unknown; current: unknown; index?: number };
function lookup(value: unknown, segments: string[]): unknown {
  for (const key of segments) {
    if (value == null || !Object.prototype.hasOwnProperty.call(value, key)) return MISSING;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}
function resolve(path: string, context: Context): unknown {
  const segments = path.split(".");
  if (segments[0] === "this") return lookup(context.current, segments.slice(1));
  if (segments[0] === "@index") return lookup(context.index, segments.slice(1));
  const local = lookup(context.current, segments);
  return local === MISSING ? lookup(context.root, segments) : local;
}
function truthy(value: unknown): boolean {
  return value !== MISSING && value != null && value !== "" && value !== 0
    && value !== 0n && value !== false && (!Array.isArray(value) || value.length > 0);
}
function scalar(value: unknown, path: string, at: Position): string {
  if (value === MISSING || value == null) return "";
  switch (typeof value) {
    case "string": case "number": case "boolean": case "bigint": return String(value);
    default: return fail(`Cannot render non-scalar value for ${JSON.stringify(path)} (${Array.isArray(value) ? "array" : typeof value})`, at);
  }
}
const escapes: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Render a template using own-property paths and HTML escaping by default. */
export function render(template: string, data: unknown): string {
  const output: string[] = [];
  function visit(nodes: Node[], context: Context): void {
    for (const node of nodes) {
      if (node.kind === "text") { output.push(node.value); continue; }
      const value = resolve(node.path, context);
      if (node.kind === "value") {
        const text = scalar(value, node.path, node.at);
        output.push(node.raw ? text : text.replace(/[&<>"']/g, char => escapes[char]!));
      } else if (node.kind === "if") {
        visit(truthy(value) ? node.yes : node.no, context);
      } else if (Array.isArray(value) && value.length > 0) {
        for (let index = 0; index < value.length; index++) {
          visit(node.yes, { root: context.root, current: value[index], index });
        }
      } else {
        visit(node.no, context);
      }
    }
  }
  visit(parse(template), { root: data, current: data });
  return output.join("");
}
