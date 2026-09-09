type Location = { line: number; column: number };
type TextNode = { kind: "text"; value: string };
type ValueNode = { kind: "value"; path: string; raw: boolean; location: Location };
type BlockNode = {
  kind: "if" | "each";
  path: string;
  body: Node[];
  alternate: Node[];
  location: Location;
};
type Node = TextNode | ValueNode | BlockNode;
type Frame = { block: BlockNode; hasElse: boolean };
type Context = { root: unknown; item?: unknown; index?: number; inLoop: boolean };

function fail(message: string, location: Location): never {
  throw new Error(`${message} at line ${location.line}, column ${location.column}`);
}

function validatePath(path: string, location: Location): string {
  if (!/^(?:@index|[^\s.{}#/!@]+)(?:\.[^\s.{}#/!@]+)*$/.test(path)) {
    fail(`Invalid path ${JSON.stringify(path)}`, location);
  }
  return path;
}

function parse(template: string): Node[] {
  const nodes: Node[] = [];
  const stack: Frame[] = [];
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
      target.push({ kind: "text", value: template.slice(cursor) });
      break;
    }
    if (start > cursor) target.push({ kind: "text", value: template.slice(cursor, start) });
    advance(start);
    const location = { line, column };
    const raw = template.startsWith("{{{", start);
    const openingLength = raw ? 3 : 2;
    const closing = raw ? "}}}" : "}}";
    const end = template.indexOf(closing, start + openingLength);
    if (end === -1) fail("Unclosed tag", location);
    const tag = template.slice(start + openingLength, end).trim();
    advance(end + closing.length);

    if (!raw && tag.startsWith("!")) continue;
    if (!raw && tag.startsWith("#")) {
      const match = /^#([^\s]+)(?:\s+([\s\S]*))?$/.exec(tag);
      const kind = match?.[1];
      if (kind !== "if" && kind !== "each") fail(`Unknown block ${JSON.stringify(kind ?? tag)}`, location);
      const block: BlockNode = {
        kind,
        path: validatePath(match?.[2] ?? "", location),
        body: [],
        alternate: [],
        location,
      };
      target.push(block);
      stack.push({ block, hasElse: false });
      target = block.body;
    } else if (!raw && tag === "else") {
      const frame = stack[stack.length - 1];
      if (!frame) fail("else outside a block", location);
      if (frame.hasElse) fail("Duplicate else", location);
      frame.hasElse = true;
      target = frame.block.alternate;
    } else if (!raw && tag.startsWith("/")) {
      const frame = stack[stack.length - 1];
      if (!frame) fail(`Unexpected closing tag ${JSON.stringify(tag)}`, location);
      if (tag !== `/${frame.block.kind}`) {
        fail(`Mismatched closing tag ${JSON.stringify(tag)}; expected /${frame.block.kind}`, location);
      }
      stack.pop();
      const parent = stack[stack.length - 1];
      target = parent ? (parent.hasElse ? parent.block.alternate : parent.block.body) : nodes;
    } else {
      target.push({ kind: "value", path: validatePath(tag, location), raw, location });
    }
  }
  const unclosed = stack[stack.length - 1];
  if (unclosed) fail(`Unclosed ${unclosed.block.kind} block`, unclosed.block.location);
  return nodes;
}

// A missing property is distinct from an explicitly present undefined value.
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
  let result: unknown;
  if (parts[0] === "this") {
    result = lookup(context.inLoop ? context.item : context.root, parts.slice(1));
  } else if (parts[0] === "@index") {
    result = lookup(context.index, parts.slice(1));
  } else {
    result = context.inLoop ? lookup(context.item, parts) : missing;
    if (result === missing) result = lookup(context.root, parts);
  }
  return result === missing ? undefined : result;
}

function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return value !== "" && value !== 0 && value !== 0n && value !== false && value != null;
}

const escapes: Record<string, string> = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
};

function scalar(value: unknown, node: ValueNode): string {
  if (value == null) return "";
  if (typeof value === "object" || typeof value === "function") {
    fail(`Cannot render ${JSON.stringify(node.path)} as scalar text (received ${Array.isArray(value) ? "array" : typeof value})`, node.location);
  }
  const text = String(value);
  return node.raw ? text : text.replace(/[&<>"']/g, character => escapes[character]!);
}

function evaluate(nodes: Node[], context: Context, output: string[]): void {
  for (const node of nodes) {
    if (node.kind === "text") {
      output.push(node.value);
    } else if (node.kind === "value") {
      output.push(scalar(resolve(node.path, context), node));
    } else {
      const value = resolve(node.path, context);
      if (node.kind === "if") {
        evaluate(truthy(value) ? node.body : node.alternate, context, output);
      } else if (Array.isArray(value) && value.length > 0) {
        for (let index = 0; index < value.length; index++) {
          evaluate(node.body, { root: context.root, item: value[index], index, inLoop: true }, output);
        }
      } else {
        evaluate(node.alternate, context, output);
      }
    }
  }
}

/** Render a template, throwing a located error for invalid syntax or non-scalar output. */
export function render(template: string, data: unknown): string {
  const nodes = parse(template);
  const output: string[] = [];
  evaluate(nodes, { root: data, inLoop: false }, output);
  return output.join("");
}
