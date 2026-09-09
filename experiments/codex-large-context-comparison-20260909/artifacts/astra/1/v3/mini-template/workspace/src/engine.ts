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
type Frame = { node: BlockNode; parent: Node[]; hasElse: boolean };
type Context = { root: unknown; item?: unknown; index?: number; inLoop: boolean };

function fail(message: string, at: Location): never {
  throw new Error(`${message} at line ${at.line}, column ${at.column}`);
}

function checkPath(path: string, at: Location): void {
  if (!/^(?:@index|[^\s.{}#/!]+(?:\.[^\s.{}#/!]+)*)$/.test(path)) {
    fail(`Invalid path ${JSON.stringify(path)}`, at);
  }
}

function parse(template: string): Node[] {
  const result: Node[] = [];
  const stack: Frame[] = [];
  let target = result;
  let offset = 0;
  let line = 1;
  let column = 1;
  function advance(end: number): void {
    while (offset < end) {
      if (template[offset++] === "\n") {
        line++;
        column = 1;
      } else column++;
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
      const kind = match?.[1];
      if (kind !== "if" && kind !== "each") fail(`Unknown block ${JSON.stringify(kind ?? tag)}`, at);
      const path = match?.[2]?.trim() ?? "";
      checkPath(path, at);
      const node: BlockNode = { kind, path, yes: [], no: [], at };
      target.push(node);
      stack.push({ node, parent: target, hasElse: false });
      target = node.yes;
    } else if (!raw && tag === "else") {
      const frame = stack[stack.length - 1];
      if (!frame) fail("else outside a block", at);
      if (frame.hasElse) fail("Duplicate else", at);
      frame.hasElse = true;
      target = frame.node.no;
    } else if (!raw && tag.startsWith("/")) {
      const frame = stack[stack.length - 1];
      if (!frame) fail(`Unexpected closing tag ${tag}`, at);
      if (tag !== `/${frame.node.kind}`) fail(`Mismatched closing tag ${tag}; expected /${frame.node.kind}`, at);
      stack.pop();
      target = frame.parent;
    } else {
      checkPath(tag, at);
      target.push({ kind: "value", path: tag, raw, at });
    }
  }
  if (stack.length) {
    const frame = stack[stack.length - 1]!;
    fail(`Unclosed ${frame.node.kind} block`, frame.node.at);
  }
  return result;
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
    const value = lookup(context.inLoop ? context.item : context.root, parts.slice(1));
    return value === missing ? undefined : value;
  }
  if (context.inLoop) {
    const value = lookup(context.item, parts);
    if (value !== missing) return value;
  }
  const value = lookup(context.root, parts);
  return value === missing ? undefined : value;
}

function truthy(value: unknown): boolean {
  return Array.isArray(value) ? value.length > 0 : Boolean(value);
}

function scalar(value: unknown, path: string, at: Location): string {
  if (value == null) return "";
  if (typeof value === "object" || typeof value === "function") {
    fail(`Cannot render non-scalar value at path ${JSON.stringify(path)}`, at);
  }
  return String(value);
}

const entities: Record<string, string> = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
};

/** Render a template, throwing a located error for invalid syntax or non-scalar output. */
export function render(template: string, data: unknown): string {
  const nodes = parse(template);
  const output: string[] = [];
  function visit(nodes: Node[], context: Context): void {
    for (const node of nodes) {
      if (node.kind === "text") {
        output.push(node.text);
      } else if (node.kind === "value") {
        const text = scalar(resolve(node.path, context), node.path, node.at);
        output.push(node.raw ? text : text.replace(/[&<>"']/g, char => entities[char]!));
      } else {
        const value = resolve(node.path, context);
        if (node.kind === "if") {
          visit(truthy(value) ? node.yes : node.no, context);
        } else if (Array.isArray(value) && value.length > 0) {
          for (let index = 0; index < value.length; index++) {
            visit(node.yes, { root: context.root, item: value[index], index, inLoop: true });
          }
        } else visit(node.no, context);
      }
    }
  }
  visit(nodes, { root: data, inLoop: false });
  return output.join("");
}
