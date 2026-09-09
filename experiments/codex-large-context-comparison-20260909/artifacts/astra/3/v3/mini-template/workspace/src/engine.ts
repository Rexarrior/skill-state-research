type Node =
  | { kind: "text"; value: string }
  | { kind: "value"; path: string; raw: boolean; at: number }
  | { kind: "if" | "each"; path: string; body: Node[]; otherwise: Node[]; at: number };

type Block = Extract<Node, { kind: "if" | "each" }>;
type Context = { item: unknown; index: number };
const missing = Symbol("missing");

/** Render a template without evaluating code or mutating its input. */
export function render(template: string, data: unknown): string {
  function fail(message: string, at: number): never {
    const preceding = template.slice(0, at);
    const line = preceding.split("\n").length;
    const column = at - preceding.lastIndexOf("\n");
    throw new Error(`${message} at line ${line}, column ${column}`);
  }

  function path(value: string, at: number): string {
    if (!/^(?:@index|(?:this|[A-Za-z_$][\w$]*|\d+)(?:\.(?:[A-Za-z_$][\w$]*|\d+))*)$/.test(value)) {
      fail(`Invalid path ${JSON.stringify(value)}`, at);
    }
    return value;
  }

  const nodes: Node[] = [];
  const stack: { block: Block; parent: Node[]; hasElse: boolean }[] = [];
  let target = nodes;
  let cursor = 0;
  while (cursor < template.length) {
    const at = template.indexOf("{{", cursor);
    if (at < 0) {
      target.push({ kind: "text", value: template.slice(cursor) });
      break;
    }
    if (at > cursor) target.push({ kind: "text", value: template.slice(cursor, at) });
    const raw = template.startsWith("{{{", at);
    const close = raw ? "}}}" : "}}";
    const end = template.indexOf(close, at + (raw ? 3 : 2));
    if (end < 0) fail("Unclosed tag", at);
    const tag = template.slice(at + (raw ? 3 : 2), end).trim();
    cursor = end + close.length;
    if (!raw && tag.startsWith("!")) continue;
    if (!raw && tag.startsWith("#")) {
      const match = /^#(\S+)(?:\s+([\s\S]*))?$/.exec(tag);
      const kind = match?.[1];
      if (kind !== "if" && kind !== "each") fail(`Unknown block ${JSON.stringify(kind ?? tag)}`, at);
      const block: Block = { kind, path: path(match?.[2]?.trim() ?? "", at), body: [], otherwise: [], at };
      target.push(block);
      stack.push({ block, parent: target, hasElse: false });
      target = block.body;
    } else if (!raw && tag === "else") {
      const frame = stack[stack.length - 1];
      if (!frame) fail("else outside a block", at);
      if (frame.hasElse) fail("Duplicate else", at);
      frame.hasElse = true;
      target = frame.block.otherwise;
    } else if (!raw && tag.startsWith("/")) {
      const frame = stack[stack.length - 1];
      if (!frame) fail(`Unexpected closing tag ${tag}`, at);
      if (tag !== `/${frame.block.kind}`) fail(`Mismatched closing tag ${tag}; expected /${frame.block.kind}`, at);
      stack.pop();
      target = frame.parent;
    } else {
      target.push({ kind: "value", path: path(tag, at), raw, at });
    }
  }
  if (stack.length) {
    const block = stack[stack.length - 1]!.block;
    fail(`Unclosed ${block.kind} block`, block.at);
  }

  function lookup(value: unknown, parts: string[]): unknown {
    for (const part of parts) {
      if (value == null || !Object.prototype.hasOwnProperty.call(value, part)) return missing;
      value = (value as Record<string, unknown>)[part];
    }
    return value;
  }

  function resolve(expression: string, context?: Context): unknown {
    if (expression === "@index") return context?.index;
    const parts = expression.split(".");
    if (parts[0] === "this") return lookup(context ? context.item : data, parts.slice(1));
    if (context) {
      const local = lookup(context.item, parts);
      if (local !== missing) return local;
    }
    return lookup(data, parts);
  }

  function truthy(value: unknown): boolean {
    return value !== missing && Boolean(value) && (!Array.isArray(value) || value.length > 0);
  }

  function scalar(value: unknown, node: Extract<Node, { kind: "value" }>): string {
    if (value === missing || value == null) return "";
    if (typeof value === "object" || typeof value === "function") {
      fail(`Cannot render non-scalar value at path ${JSON.stringify(node.path)} (${Array.isArray(value) ? "array" : typeof value})`, node.at);
    }
    const text = String(value);
    const escapes: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return node.raw ? text : text.replace(/[&<>"']/g, char => escapes[char]!);
  }

  function evaluate(sequence: Node[], context?: Context): string {
    const output: string[] = [];
    for (const node of sequence) {
      if (node.kind === "text") output.push(node.value);
      else if (node.kind === "value") output.push(scalar(resolve(node.path, context), node));
      else {
        const value = resolve(node.path, context);
        if (node.kind === "if") output.push(evaluate(truthy(value) ? node.body : node.otherwise, context));
        else if (Array.isArray(value) && value.length > 0) {
          for (let index = 0; index < value.length; index++) {
            output.push(evaluate(node.body, { item: value[index], index }));
          }
        } else output.push(evaluate(node.otherwise, context));
      }
    }
    return output.join("");
  }
  return evaluate(nodes);
}
