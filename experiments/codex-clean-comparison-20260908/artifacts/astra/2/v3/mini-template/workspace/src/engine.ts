type Position = { line: number; column: number };
type Node =
  | { kind: "text"; value: string }
  | { kind: "value"; path: string; raw: boolean; position: Position }
  | Block;
type Block = {
  kind: "if" | "each";
  path: string;
  body: Node[];
  alternate: Node[];
  position: Position;
};
type Context = { root: unknown; item: unknown; index?: number };

function fail(message: string, position: Position): never {
  throw new Error(`${message} at line ${position.line}, column ${position.column}`);
}

function checkPath(path: string, position: Position): void {
  if (!/^(?:@index|[^\s.{}#\/!@]+(?:\.[^\s.{}#\/!@]+)*)$/.test(path)) {
    fail(`Invalid path ${JSON.stringify(path)}`, position);
  }
}

function parse(template: string): Node[] {
  const result: Node[] = [];
  const stack: { block: Block; parent: Node[]; hasElse: boolean }[] = [];
  let nodes = result;
  let offset = 0;
  let line = 1;
  let column = 1;
  function advance(end: number): void {
    for (; offset < end; offset++) {
      if (template[offset] === "\n") {
        line++;
        column = 1;
      } else column++;
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
    const position = { line, column };
    const raw = template.startsWith("{{{", start);
    const openerLength = raw ? 3 : 2;
    const closer = raw ? "}}}" : "}}";
    const end = template.indexOf(closer, start + openerLength);
    if (end === -1) fail("Unclosed tag", position);
    const tag = template.slice(start + openerLength, end).trim();
    advance(end + closer.length);
    if (!raw && tag.startsWith("!")) continue;
    if (!raw && tag.startsWith("#")) {
      const match = /^#(\S+)(?:\s+(.+))?$/.exec(tag);
      const kind = match?.[1];
      if (kind !== "if" && kind !== "each") fail(`Unknown block ${JSON.stringify(kind ?? tag)}`, position);
      const path = match?.[2] ?? "";
      checkPath(path, position);
      const block: Block = { kind, path, body: [], alternate: [], position };
      nodes.push(block);
      stack.push({ block, parent: nodes, hasElse: false });
      nodes = block.body;
    } else if (!raw && tag === "else") {
      const frame = stack[stack.length - 1];
      if (!frame) fail("else outside a block", position);
      if (frame.hasElse) fail("Duplicate else", position);
      frame.hasElse = true;
      nodes = frame.block.alternate;
    } else if (!raw && tag.startsWith("/")) {
      const frame = stack[stack.length - 1];
      if (!frame) fail(`Unexpected closing tag ${tag}`, position);
      if (tag !== `/${frame.block.kind}`) fail(`Mismatched closing tag ${tag}; expected /${frame.block.kind}`, position);
      stack.pop();
      nodes = frame.parent;
    } else {
      checkPath(tag, position);
      nodes.push({ kind: "value", path: tag, raw, position });
    }
  }
  const unclosed = stack[stack.length - 1];
  if (unclosed) fail(`Unclosed ${unclosed.block.kind} block`, unclosed.block.position);
  return result;
}

function lookup(value: unknown, parts: string[]): { found: boolean; value: unknown } {
  for (const part of parts) {
    if (value == null || !Object.prototype.hasOwnProperty.call(value, part)) {
      return { found: false, value: undefined };
    }
    value = (Object(value) as Record<string, unknown>)[part];
  }
  return { found: true, value };
}

function resolve(path: string, context: Context): unknown {
  if (path === "@index") return context.index;
  const parts = path.split(".");
  if (parts[0] === "this") return lookup(context.item, parts.slice(1)).value;
  const local = lookup(context.item, parts);
  return local.found ? local.value : lookup(context.root, parts).value;
}

function truthy(value: unknown): boolean {
  return Array.isArray(value)
    ? value.length > 0
    : value !== "" && value !== 0 && value !== false && value != null;
}

function scalar(value: unknown, path: string, position: Position): string {
  if (value == null) return "";
  if (typeof value === "object" || typeof value === "function") {
    fail(`Cannot render ${JSON.stringify(path)} as scalar text (${Array.isArray(value) ? "array" : typeof value})`, position);
  }
  return String(value);
}

const escapes: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

function evaluate(nodes: Node[], context: Context, output: string[]): void {
  for (const node of nodes) {
    if (node.kind === "text") {
      output.push(node.value);
      continue;
    }
    const value = resolve(node.path, context);
    if (node.kind === "value") {
      const text = scalar(value, node.path, node.position);
      output.push(node.raw ? text : text.replace(/[&<>"']/g, character => escapes[character]!));
    } else if (node.kind === "if") {
      evaluate(truthy(value) ? node.body : node.alternate, context, output);
    } else if (Array.isArray(value) && value.length > 0) {
      for (let index = 0; index < value.length; index++) {
        evaluate(node.body, { root: context.root, item: value[index], index }, output);
      }
    } else {
      evaluate(node.alternate, context, output);
    }
  }
}

/** Render a template, throwing on malformed structure or non-scalar interpolation. */
export function render(template: string, data: unknown): string {
  const output: string[] = [];
  evaluate(parse(template), { root: data, item: data }, output);
  return output.join("");
}
