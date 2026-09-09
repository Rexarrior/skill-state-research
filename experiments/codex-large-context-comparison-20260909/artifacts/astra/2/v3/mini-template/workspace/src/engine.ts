type Node =
  | { kind: "text"; value: string }
  | { kind: "value"; path: string; raw: boolean; at: number }
  | { kind: "if" | "each"; path: string; yes: Node[]; no: Node[]; at: number };
type Block = Extract<Node, { kind: "if" | "each" }>;
type Context = { root: unknown; item: unknown; index?: number };

/** Render a template with escaped interpolation and nested conditional/array blocks. */
export function render(template: string, data: unknown): string {
  const fail = (message: string, at: number): never => {
    const before = template.slice(0, at);
    const line = before.split(/\r\n|\r|\n/).length;
    const column = at - Math.max(before.lastIndexOf("\n"), before.lastIndexOf("\r"));
    throw new Error(`${message} at line ${line}, column ${column}`);
  };
  const checkPath = (path: string, at: number): string => {
    if (!/^(?:@index|[^\s.{}#\/!@]+)(?:\.[^\s.{}#\/!@]+)*$/.test(path)) {
      fail(`Invalid path ${JSON.stringify(path)}`, at);
    }
    return path;
  };
  const nodes: Node[] = [];
  const stack: { block: Block; parent: Node[]; hasElse: boolean }[] = [];
  let target = nodes;
  let position = 0;
  while (position < template.length) {
    const start = template.indexOf("{{", position);
    if (start < 0) {
      target.push({ kind: "text", value: template.slice(position) });
      break;
    }
    if (start > position) target.push({ kind: "text", value: template.slice(position, start) });
    const raw = template.startsWith("{{{", start);
    const close = raw ? "}}}" : "}}";
    const end = template.indexOf(close, start + (raw ? 3 : 2));
    if (end < 0) fail("Unclosed tag", start);
    const tag = template.slice(start + (raw ? 3 : 2), end).trim();
    position = end + close.length;
    if (!raw && tag.startsWith("!")) continue;
    if (!raw && tag.startsWith("#")) {
      const match = /^#(\S+)(?:\s+([\s\S]*))?$/.exec(tag);
      const kind = match?.[1];
      if (kind !== "if" && kind !== "each") fail(`Unknown block ${JSON.stringify(kind ?? tag)}`, start);
      const block: Block = { kind: kind as "if" | "each", path: checkPath(match?.[2]?.trim() ?? "", start), yes: [], no: [], at: start };
      target.push(block);
      stack.push({ block, parent: target, hasElse: false });
      target = block.yes;
    } else if (!raw && tag === "else") {
      const frame = stack[stack.length - 1];
      if (!frame) fail("else outside a block", start);
      if (frame.hasElse) fail("Duplicate else", start);
      frame.hasElse = true;
      target = frame.block.no;
    } else if (!raw && tag.startsWith("/")) {
      const frame = stack[stack.length - 1];
      if (!frame) fail(`Unexpected closing tag ${tag}`, start);
      if (tag !== `/${frame.block.kind}`) fail(`Mismatched closing tag ${tag}; expected /${frame.block.kind}`, start);
      stack.pop();
      target = frame.parent;
    } else {
      target.push({ kind: "value", path: checkPath(tag, start), raw, at: start });
    }
  }
  if (stack.length) {
    const block = stack[stack.length - 1].block;
    fail(`Unclosed ${block.kind} block`, block.at);
  }

  const missing = Symbol("missing");
  const lookup = (base: unknown, parts: string[]): unknown => {
    let value = base;
    for (const part of parts) {
      if (value == null || !Object.prototype.hasOwnProperty.call(value, part)) return missing;
      value = (value as Record<string, unknown>)[part];
    }
    return value;
  };
  const resolve = (path: string, context: Context): unknown => {
    const parts = path.split(".");
    if (parts[0] === "this") return lookup(context.item, parts.slice(1));
    if (parts[0] === "@index") return lookup(context.index, parts.slice(1));
    const local = lookup(context.item, parts);
    return local === missing ? lookup(context.root, parts) : local;
  };
  const truthy = (value: unknown): boolean => value !== missing && Boolean(value) && (!Array.isArray(value) || value.length > 0);
  const escape = (value: string): string => value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
  const visit = (list: Node[], context: Context): string => {
    let output = "";
    for (const node of list) {
      if (node.kind === "text") { output += node.value; continue; }
      const value = resolve(node.path, context);
      if (node.kind === "value") {
        if (value === missing || value == null) continue;
        if (typeof value === "object" || typeof value === "function") fail(`Cannot render non-scalar value for path ${JSON.stringify(node.path)}`, node.at);
        const text = String(value);
        output += node.raw ? text : escape(text);
      } else if (node.kind === "if") {
        output += visit(truthy(value) ? node.yes : node.no, context);
      } else if (Array.isArray(value) && value.length > 0) {
        for (let index = 0; index < value.length; index++) {
          output += visit(node.yes, { root: context.root, item: value[index], index });
        }
      } else {
        output += visit(node.no, context);
      }
    }
    return output;
  };
  return visit(nodes, { root: data, item: data });
}
