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
type Frame = { node: BlockNode; inElse: boolean };
type Context = { root: unknown; item?: unknown; index?: number; inLoop: boolean };

function fail(message: string, at: Location): never {
  throw new Error(`${message} at line ${at.line}, column ${at.column}`);
}

function checkPath(path: string, at: Location): string {
  if (path !== "@index" && !path.split(".").every(part => /^[^.\s{}#/!@]+$/.test(part))) {
    fail(`Invalid path ${JSON.stringify(path)}`, at);
  }
  return path;
}

function parse(template: string): Node[] {
  const nodes: Node[] = [];
  const stack: Frame[] = [];
  let cursor = 0;
  let line = 1;
  let column = 1;
  function advance(end: number) {
    for (; cursor < end; cursor++) {
      if (template[cursor] === "\n") { line++; column = 1; }
      else column++;
    }
  }
  function append(node: Node) {
    const frame = stack[stack.length - 1];
    (frame ? (frame.inElse ? frame.node.otherwise : frame.node.body) : nodes).push(node);
  }
  while (cursor < template.length) {
    const start = template.indexOf("{{", cursor);
    if (start === -1) {
      append({ kind: "text", text: template.slice(cursor) });
      break;
    }
    if (start > cursor) append({ kind: "text", text: template.slice(cursor, start) });
    advance(start);
    const at = { line, column };
    const raw = template.startsWith("{{{", start);
    const opening = raw ? 3 : 2;
    const closing = raw ? "}}}" : "}}";
    const end = template.indexOf(closing, start + opening);
    if (end === -1) fail("Unclosed tag", at);
    const tag = template.slice(start + opening, end).trim();
    advance(end + closing.length);
    if (raw) {
      append({ kind: "value", path: checkPath(tag, at), raw: true, at });
    } else if (tag.startsWith("!")) {
      continue;
    } else if (tag.startsWith("#")) {
      const match = /^#(\S+)(?:\s+([\s\S]*))?$/.exec(tag);
      const name = match?.[1];
      if (name !== "if" && name !== "each") fail(`Unknown block ${JSON.stringify(name ?? tag)}`, at);
      const node: BlockNode = {
        kind: name, path: checkPath(match?.[2] ?? "", at), body: [], otherwise: [], at,
      };
      append(node);
      stack.push({ node, inElse: false });
    } else if (tag === "else") {
      const frame = stack[stack.length - 1];
      if (!frame) fail("else outside a block", at);
      if (frame.inElse) fail("Duplicate else", at);
      frame.inElse = true;
    } else if (tag.startsWith("/")) {
      const name = tag.slice(1).trim();
      const frame = stack[stack.length - 1];
      if (!frame) fail(`Unexpected closing tag ${JSON.stringify(tag)}`, at);
      if (name !== frame.node.kind) fail(`Mismatched closing tag: expected /${frame.node.kind}, got ${tag}`, at);
      stack.pop();
    } else {
      append({ kind: "value", path: checkPath(tag, at), raw: false, at });
    }
  }
  const unclosed = stack[stack.length - 1];
  if (unclosed) fail(`Unclosed ${unclosed.node.kind} block`, unclosed.node.at);
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
    return lookup(context.inLoop ? context.item : context.root, parts.slice(1));
  }
  if (context.inLoop) {
    const local = lookup(context.item, parts);
    if (local !== missing) return local;
  }
  return lookup(context.root, parts);
}

function truthy(value: unknown): boolean {
  return value !== missing && Boolean(value) && (!Array.isArray(value) || value.length > 0);
}

const escapes: Record<string, string> = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
};

function scalar(value: unknown, node: ValueNode): string {
  if (value === missing || value == null) return "";
  if (typeof value === "object" || typeof value === "function") {
    fail(`Cannot render ${JSON.stringify(node.path)} as scalar text (${Array.isArray(value) ? "array" : typeof value})`, node.at);
  }
  const text = String(value);
  return node.raw ? text : text.replace(/[&<>"']/g, char => escapes[char]!);
}

function renderNodes(nodes: Node[], context: Context, output: string[]): void {
  for (const node of nodes) {
    if (node.kind === "text") { output.push(node.text); continue; }
    const value = resolve(node.path, context);
    if (node.kind === "value") {
      output.push(scalar(value, node));
    } else if (node.kind === "if") {
      renderNodes(truthy(value) ? node.body : node.otherwise, context, output);
    } else if (Array.isArray(value) && value.length > 0) {
      for (let index = 0; index < value.length; index++) {
        renderNodes(node.body, { root: context.root, item: value[index], index, inLoop: true }, output);
      }
    } else {
      renderNodes(node.otherwise, context, output);
    }
  }
}

/** Render a template with HTML escaping by default. */
export function render(template: string, data: unknown): string {
  const output: string[] = [];
  renderNodes(parse(template), { root: data, inLoop: false }, output);
  return output.join("");
}
