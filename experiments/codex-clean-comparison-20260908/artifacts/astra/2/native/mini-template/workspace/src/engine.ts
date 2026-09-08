type Location = { line: number; column: number };
type TextNode = { kind: "text"; text: string };
type ValueNode = { kind: "value"; path: string; raw: boolean; at: Location };
type BlockNode = {
  kind: "if" | "each";
  path: string;
  yes: Node[];
  no: Node[];
  at: Location;
};
type Node = TextNode | ValueNode | BlockNode;
type Context = { root: unknown; item?: unknown; index?: number };

function fail(message: string, at: Location): never {
  throw new Error(`${message} at line ${at.line}, column ${at.column}`);
}

function checkPath(path: string, at: Location): string {
  if (!/^(?:@index|[A-Za-z_$0-9]+(?:\.[A-Za-z_$0-9]+)*)$/.test(path)) {
    fail(`Invalid path ${JSON.stringify(path)}`, at);
  }
  return path;
}

function parse(template: string): Node[] {
  const nodes: Node[] = [];
  const stack: { block: BlockNode; parent: Node[]; hasElse: boolean }[] = [];
  let target = nodes;
  let cursor = 0;
  let line = 1;
  let column = 1;

  function advance(end: number): void {
    while (cursor < end) {
      if (template[cursor++] === "\n") {
        line++;
        column = 1;
      } else {
        column++;
      }
    }
  }

  while (cursor < template.length) {
    const start = template.indexOf("{{", cursor);
    if (start === -1) {
      target.push({ kind: "text", text: template.slice(cursor) });
      break;
    }
    if (start > cursor) target.push({ kind: "text", text: template.slice(cursor, start) });
    advance(start);
    const at = { line, column };
    const raw = template.startsWith("{{{", start);
    const openingLength = raw ? 3 : 2;
    const closing = raw ? "}}}" : "}}";
    const end = template.indexOf(closing, start + openingLength);
    if (end === -1) fail("Unclosed tag", at);
    const tag = template.slice(start + openingLength, end).trim();
    advance(end + closing.length);

    if (!raw && tag.startsWith("!")) continue;
    if (!raw && tag.startsWith("#")) {
      const match = /^#(\S+)(?:\s+(.+))?$/.exec(tag);
      const kind = match?.[1];
      if (kind !== "if" && kind !== "each") fail(`Unknown block ${JSON.stringify(kind ?? tag)}`, at);
      const block: BlockNode = {
        kind, path: checkPath(match?.[2]?.trim() ?? "", at), yes: [], no: [], at,
      };
      target.push(block);
      stack.push({ block, parent: target, hasElse: false });
      target = block.yes;
    } else if (!raw && tag === "else") {
      const frame = stack[stack.length - 1];
      if (!frame) fail("else outside a block", at);
      if (frame.hasElse) fail("Duplicate else", at);
      frame.hasElse = true;
      target = frame.block.no;
    } else if (!raw && tag.startsWith("/")) {
      const frame = stack[stack.length - 1];
      if (!frame) fail(`Unexpected closing tag ${tag}`, at);
      if (tag !== `/${frame.block.kind}`) {
        fail(`Mismatched closing tag ${tag}; expected /${frame.block.kind}`, at);
      }
      stack.pop();
      target = frame.parent;
    } else {
      target.push({ kind: "value", path: checkPath(tag, at), raw, at });
    }
  }
  const unclosed = stack[stack.length - 1];
  if (unclosed) fail(`Unclosed ${unclosed.block.kind} block`, unclosed.block.at);
  return nodes;
}

const missing = Symbol("missing");

function lookup(value: unknown, parts: string[]): unknown {
  for (const part of parts) {
    if (value == null || !Object.prototype.hasOwnProperty.call(value, part)) return missing;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

function resolve(path: string, context: Context): unknown {
  if (path === "@index") return context.index;
  const parts = path.split(".");
  if (parts[0] === "this") {
    return lookup(context.index === undefined ? context.root : context.item, parts.slice(1));
  }
  if (context.index !== undefined) {
    const local = lookup(context.item, parts);
    if (local !== missing) return local;
  }
  return lookup(context.root, parts);
}

function truthy(value: unknown): boolean {
  return value !== missing && Boolean(value) && (!Array.isArray(value) || value.length > 0);
}

function scalar(value: unknown, node: ValueNode): string {
  if (value === missing || value == null) return "";
  if (!["string", "number", "boolean", "bigint"].includes(typeof value)) {
    fail(`Cannot render non-scalar value at path ${JSON.stringify(node.path)} (${Array.isArray(value) ? "array" : typeof value})`, node.at);
  }
  const text = String(value);
  if (node.raw) return text;
  const escapes: Record<string, string> = {
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  };
  return text.replace(/[&<>"']/g, (character) => escapes[character]!);
}

function evaluate(nodes: Node[], context: Context, output: string[]): void {
  for (const node of nodes) {
    if (node.kind === "text") {
      output.push(node.text);
    } else if (node.kind === "value") {
      output.push(scalar(resolve(node.path, context), node));
    } else {
      const value = resolve(node.path, context);
      if (node.kind === "if") {
        evaluate(truthy(value) ? node.yes : node.no, context, output);
      } else if (Array.isArray(value) && value.length > 0) {
        for (let index = 0; index < value.length; index++) {
          evaluate(node.yes, { root: context.root, item: value[index], index }, output);
        }
      } else {
        evaluate(node.no, context, output);
      }
    }
  }
}

/** Render a template, throwing a located error for malformed syntax or non-scalar output. */
export function render(template: string, data: unknown): string {
  const output: string[] = [];
  evaluate(parse(template), { root: data }, output);
  return output.join("");
}
