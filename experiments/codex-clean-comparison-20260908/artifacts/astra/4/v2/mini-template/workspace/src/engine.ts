type Path = { source: string; parts: string[] };
type Node =
  | { kind: "text"; value: string }
  | { kind: "value"; path: Path; raw: boolean; offset: number }
  | { kind: "if" | "each"; path: Path; body: Node[]; alternate: Node[]; offset: number };
type Block = Extract<Node, { kind: "if" | "each" }>;
type Context = { root: unknown; item?: unknown; index?: number; inLoop: boolean };

/** Render a template. Syntax and non-scalar interpolation errors include a source location. */
export function render(template: string, data: unknown): string {
  function fail(message: string, offset: number): never {
    const prefix = template.slice(0, offset);
    const line = prefix.split("\n").length;
    const column = offset - prefix.lastIndexOf("\n");
    throw new Error(`${message} at line ${line}, column ${column}`);
  }

  function path(source: string, offset: number): Path {
    if (!/^(?:@index|[A-Za-z_$][\w$]*)(?:\.(?:[A-Za-z_$][\w$]*|\d+))*$/.test(source)) {
      fail(`Invalid path ${JSON.stringify(source)}`, offset);
    }
    return { source, parts: source.split(".") };
  }

  const nodes: Node[] = [];
  const stack: { block: Block; parent: Node[]; hasElse: boolean }[] = [];
  let target = nodes;
  let cursor = 0;
  while (cursor < template.length) {
    const start = template.indexOf("{{", cursor);
    if (start < 0) {
      target.push({ kind: "text", value: template.slice(cursor) });
      break;
    }
    if (start > cursor) target.push({ kind: "text", value: template.slice(cursor, start) });
    const raw = template.startsWith("{{{", start);
    const opening = raw ? 3 : 2;
    const closing = raw ? "}}}" : "}}";
    const end = template.indexOf(closing, start + opening);
    if (end < 0) fail("Unclosed tag", start);
    const tag = template.slice(start + opening, end).trim();
    cursor = end + closing.length;
    if (!raw && tag.startsWith("!")) continue;
    if (!raw && tag.startsWith("#")) {
      const match = /^#(\S+)(?:\s+([\s\S]*))?$/.exec(tag);
      const kind = match?.[1];
      if (kind !== "if" && kind !== "each") fail(`Unknown block ${JSON.stringify(kind ?? tag)}`, start);
      const block: Block = { kind, path: path(match?.[2]?.trim() ?? "", start), body: [], alternate: [], offset: start };
      target.push(block);
      stack.push({ block, parent: target, hasElse: false });
      target = block.body;
    } else if (!raw && tag === "else") {
      const frame = stack[stack.length - 1];
      if (!frame) fail("else outside a block", start);
      if (frame.hasElse) fail("Duplicate else", start);
      frame.hasElse = true;
      target = frame.block.alternate;
    } else if (!raw && tag.startsWith("/")) {
      const frame = stack[stack.length - 1];
      if (!frame) fail(`Unexpected closing tag ${tag}`, start);
      if (tag !== `/${frame.block.kind}`) fail(`Mismatched closing tag ${tag}; expected /${frame.block.kind}`, start);
      stack.pop();
      target = frame.parent;
    } else {
      target.push({ kind: "value", path: path(tag, start), raw, offset: start });
    }
  }
  if (stack.length) {
    const block = stack[stack.length - 1].block;
    fail(`Unclosed ${block.kind} block`, block.offset);
  }

  const missing = Symbol("missing");
  function lookup(value: unknown, parts: string[]): unknown {
    for (const part of parts) {
      if (value == null || !Object.prototype.hasOwnProperty.call(value, part)) return missing;
      value = (value as Record<string, unknown>)[part];
    }
    return value;
  }
  function resolve(path: Path, context: Context): unknown {
    const [first, ...rest] = path.parts;
    if (first === "this") return lookup(context.inLoop ? context.item : context.root, rest);
    if (first === "@index") return lookup(context.index, rest);
    if (context.inLoop) {
      const local = lookup(context.item, path.parts);
      if (local !== missing) return local;
    }
    return lookup(context.root, path.parts);
  }
  function truthy(value: unknown): boolean {
    return value !== missing && value != null && value !== "" && value !== 0 && value !== false
      && (!Array.isArray(value) || value.length > 0);
  }
  const escapes: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  function evaluate(list: Node[], context: Context): string {
    const output: string[] = [];
    for (const node of list) {
      if (node.kind === "text") {
        output.push(node.value);
        continue;
      }
      const value = resolve(node.path, context);
      if (node.kind === "value") {
        if (value === missing || value == null) continue;
        if (typeof value === "object" || typeof value === "function") {
          fail(`Cannot interpolate non-scalar value at path ${JSON.stringify(node.path.source)}`, node.offset);
        }
        const text = String(value);
        output.push(node.raw ? text : text.replace(/[&<>"']/g, character => escapes[character]));
      } else if (node.kind === "if") {
        output.push(evaluate(truthy(value) ? node.body : node.alternate, context));
      } else if (Array.isArray(value) && value.length > 0) {
        for (let index = 0; index < value.length; index++) {
          output.push(evaluate(node.body, { root: context.root, item: value[index], index, inLoop: true }));
        }
      } else {
        output.push(evaluate(node.alternate, context));
      }
    }
    return output.join("");
  }
  return evaluate(nodes, { root: data, inLoop: false });
}
