type Location = { line: number; column: number };
type TextNode = { kind: "text"; value: string };
type ValueNode = { kind: "value"; path: string; raw: boolean; at: Location };
type BlockNode = {
  kind: "if" | "each";
  path: string;
  body: Node[];
  alternate: Node[];
  at: Location;
};
type Node = TextNode | ValueNode | BlockNode;
type Frame = { block: BlockNode; parent: Node[]; hasElse: boolean };
type Context = { root: unknown; item?: unknown; index?: number };

function fail(message: string, at: Location): never {
  throw new Error(`${message} at line ${at.line}, column ${at.column}`);
}

function validatePath(path: string, at: Location): string {
  if (!path || !/^(?:@index|[^\s.{}#\/!@]+)(?:\.[^\s.{}#\/!@]+)*$/.test(path)) {
    fail(`Invalid path ${JSON.stringify(path)}`, at);
  }
  return path;
}

function parse(template: string): Node[] {
  const nodes: Node[] = [];
  let target = nodes;
  const stack: Frame[] = [];
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
  while (offset < template.length) {
    const start = template.indexOf("{{", offset);
    if (start < 0) {
      target.push({ kind: "text", value: template.slice(offset) });
      break;
    }
    if (start > offset) target.push({ kind: "text", value: template.slice(offset, start) });
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
      const name = match?.[1];
      if (name !== "if" && name !== "each") fail(`Unknown block ${JSON.stringify(name ?? tag)}`, at);
      const block: BlockNode = {
        kind: name, path: validatePath(match?.[2] ?? "", at), body: [], alternate: [], at,
      };
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
  if (stack.length) {
    const block = stack[stack.length - 1].block;
    fail(`Unclosed ${block.kind} block`, block.at);
  }
  return nodes;
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
  let value: unknown;
  if (parts[0] === "this") {
    value = lookup(context.index === undefined ? context.root : context.item, parts.slice(1));
  } else if (parts[0] === "@index") {
    value = lookup(context.index, parts.slice(1));
  } else {
    value = context.index === undefined ? missing : lookup(context.item, parts);
    if (value === missing) value = lookup(context.root, parts);
  }
  return value === missing ? undefined : value;
}

function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return value !== "" && value !== 0 && value !== 0n && value !== false && value != null;
}

function scalar(value: unknown, node: ValueNode): string {
  if (value == null) return "";
  switch (typeof value) {
    case "string": case "number": case "boolean": case "bigint": return String(value);
    default: return fail(`Cannot render ${node.path} as scalar text (${Array.isArray(value) ? "array" : typeof value})`, node.at);
  }
}

const escapes: Record<string, string> = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
};

/** Render a template with HTML-escaped interpolations and nested if/each blocks. */
export function render(template: string, data: unknown): string {
  const nodes = parse(template);
  const output: string[] = [];
  function visit(nodes: Node[], context: Context): void {
    for (const node of nodes) {
      if (node.kind === "text") {
        output.push(node.value);
      } else if (node.kind === "value") {
        const text = scalar(resolve(node.path, context), node);
        output.push(node.raw ? text : text.replace(/[&<>"']/g, character => escapes[character]));
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
