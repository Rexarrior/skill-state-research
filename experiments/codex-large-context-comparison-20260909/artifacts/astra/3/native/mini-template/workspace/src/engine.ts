type Position = { line: number; column: number };
type TextNode = { kind: "text"; text: string };
type ValueNode = { kind: "value"; path: string; raw: boolean; at: Position };
type BlockNode = {
  kind: "if" | "each";
  path: string;
  body: Node[];
  alternate: Node[];
  at: Position;
};
type Node = TextNode | ValueNode | BlockNode;
type Context = { root: unknown; current: unknown; index?: number };

function fail(message: string, at: Position): never {
  throw new Error(`${message} at line ${at.line}, column ${at.column}`);
}

function checkPath(path: string, at: Position): void {
  if (!/^(?:this|@index|[\w$-]+)(?:\.[\w$-]+)*$/.test(path)) {
    fail(`Invalid path ${JSON.stringify(path)}`, at);
  }
}

function parse(template: string): Node[] {
  const nodes: Node[] = [];
  const stack: { block: BlockNode; parent: Node[]; hasElse: boolean }[] = [];
  let target = nodes;
  let offset = 0;
  let line = 1;
  let column = 1;

  function advance(end: number): void {
    for (; offset < end; offset++) {
      if (template[offset] === "\n") {
        line++;
        column = 1;
      } else {
        column++;
      }
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
    const openingLength = raw ? 3 : 2;
    const closing = raw ? "}}}" : "}}";
    const end = template.indexOf(closing, start + openingLength);
    if (end === -1) fail("Unclosed tag", at);
    const tag = template.slice(start + openingLength, end).trim();
    advance(end + closing.length);

    if (!raw && tag.startsWith("!")) continue;
    if (!raw && tag.startsWith("#")) {
      const match = /^#(\S+)(?:\s+([\s\S]*))?$/.exec(tag);
      const name = match?.[1];
      if (name !== "if" && name !== "each") fail(`Unknown block ${JSON.stringify(name ?? tag)}`, at);
      const path = (match?.[2] ?? "").trim();
      checkPath(path, at);
      const block: BlockNode = { kind: name, path, body: [], alternate: [], at };
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
      const name = tag.slice(1).trim();
      const frame = stack[stack.length - 1];
      if (!frame) fail(`Unexpected closing tag ${JSON.stringify(tag)}`, at);
      if (name !== frame.block.kind) fail(`Mismatched closing tag ${JSON.stringify(tag)}; expected /${frame.block.kind}`, at);
      stack.pop();
      target = frame.parent;
    } else {
      checkPath(tag, at);
      target.push({ kind: "value", path: tag, raw, at });
    }
  }
  const unclosed = stack[stack.length - 1];
  if (unclosed) fail(`Unclosed ${unclosed.block.kind} block`, unclosed.block.at);
  return nodes;
}

function read(value: unknown, parts: string[]): unknown {
  for (const part of parts) {
    if (value == null || !Object.prototype.hasOwnProperty.call(value, part)) return undefined;
    value = (Object(value) as Record<string, unknown>)[part];
  }
  return value;
}

function resolve(path: string, context: Context): unknown {
  const parts = path.split(".");
  if (parts[0] === "this") return read(context.current, parts.slice(1));
  if (parts[0] === "@index") return read(context.index, parts.slice(1));
  const local = read(context.current, parts);
  return local === undefined ? read(context.root, parts) : local;
}

function truthy(value: unknown): boolean {
  return Boolean(value) && (!Array.isArray(value) || value.length > 0);
}

function scalar(value: unknown, path: string, at: Position): string {
  if (value == null) return "";
  if (typeof value === "object" || typeof value === "function") {
    fail(`Cannot render ${JSON.stringify(path)} as scalar text (${Array.isArray(value) ? "array" : typeof value})`, at);
  }
  return String(value);
}

const escapes: Record<string, string> = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
};

/** Render a template using own-property paths, with loop values falling back to root data. */
export function render(template: string, data: unknown): string {
  const nodes = parse(template);
  const output: string[] = [];
  function visit(children: Node[], context: Context): void {
    for (const node of children) {
      if (node.kind === "text") {
        output.push(node.text);
        continue;
      }
      const value = resolve(node.path, context);
      if (node.kind === "value") {
        const text = scalar(value, node.path, node.at);
        output.push(node.raw ? text : text.replace(/[&<>"']/g, character => escapes[character]!));
      } else if (node.kind === "if") {
        visit(truthy(value) ? node.body : node.alternate, context);
      } else if (Array.isArray(value) && value.length > 0) {
        for (let index = 0; index < value.length; index++) {
          visit(node.body, { root: context.root, current: value[index], index });
        }
      } else {
        visit(node.alternate, context);
      }
    }
  }
  visit(nodes, { root: data, current: data });
  return output.join("");
}
