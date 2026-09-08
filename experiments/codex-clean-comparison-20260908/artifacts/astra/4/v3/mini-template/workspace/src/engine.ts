type TextNode = { kind: "text"; text: string };
type ValueNode = { kind: "value"; path: string; raw: boolean; offset: number };
type BlockNode = {
  kind: "if" | "each";
  path: string;
  body: Node[];
  alternate: Node[];
  offset: number;
};
type Node = TextNode | ValueNode | BlockNode;
type Context = { value: unknown; index?: number };

/** Render a template without evaluating code or accessing inherited properties. */
export function render(template: string, data: unknown): string {
  function fail(message: string, offset: number): never {
    const prefix = template.slice(0, offset);
    const lines = prefix.split(/\r\n|\r|\n/);
    throw new Error(`${message} at line ${lines.length}, column ${lines[lines.length - 1]!.length + 1}`);
  }

  function path(expression: string, offset: number): string {
    if (!/^(?:@index|[^\s.{}#\/!@]+)(?:\.[^\s.{}#\/!@]+)*$/.test(expression)) {
      fail(`Invalid path ${JSON.stringify(expression)}`, offset);
    }
    return expression;
  }

  const nodes: Node[] = [];
  const stack: { node: BlockNode; hasElse: boolean }[] = [];
  let target = nodes;
  let cursor = 0;
  while (cursor < template.length) {
    const start = template.indexOf("{{", cursor);
    if (start < 0) {
      target.push({ kind: "text", text: template.slice(cursor) });
      break;
    }
    if (start > cursor) target.push({ kind: "text", text: template.slice(cursor, start) });
    const raw = template.startsWith("{{{", start);
    const close = raw ? "}}}" : "}}";
    const end = template.indexOf(close, start + (raw ? 3 : 2));
    if (end < 0) fail("Unclosed tag", start);
    const tag = template.slice(start + (raw ? 3 : 2), end).trim();
    cursor = end + close.length;

    if (!raw && tag.startsWith("!")) continue;
    if (!raw && tag.startsWith("#")) {
      const match = /^#(\S+)(?:\s+([\s\S]*))?$/.exec(tag);
      const name = match?.[1];
      if (name !== "if" && name !== "each") fail(`Unknown block ${JSON.stringify(name ?? tag)}`, start);
      const node: BlockNode = {
        kind: name, path: path(match?.[2]?.trim() ?? "", start),
        body: [], alternate: [], offset: start,
      };
      target.push(node);
      stack.push({ node, hasElse: false });
      target = node.body;
    } else if (!raw && tag === "else") {
      const frame = stack[stack.length - 1];
      if (!frame) fail("else outside a block", start);
      if (frame.hasElse) fail("Duplicate else", start);
      frame.hasElse = true;
      target = frame.node.alternate;
    } else if (!raw && tag.startsWith("/")) {
      const name = tag.slice(1).trim();
      const frame = stack[stack.length - 1];
      if (!frame) fail(`Unexpected closing tag ${tag}`, start);
      if (frame.node.kind !== name) fail(`Mismatched closing tag ${tag}; expected /${frame.node.kind}`, start);
      stack.pop();
      const parent = stack[stack.length - 1];
      target = parent ? (parent.hasElse ? parent.node.alternate : parent.node.body) : nodes;
    } else {
      target.push({ kind: "value", path: path(tag, start), raw, offset: start });
    }
  }
  const unclosed = stack[stack.length - 1];
  if (unclosed) fail(`Unclosed ${unclosed.node.kind} block`, unclosed.node.offset);

  function owns(value: unknown, key: string): boolean {
    return value !== null && value !== undefined && Object.prototype.hasOwnProperty.call(value, key);
  }
  function read(value: unknown, key: string): unknown {
    return owns(value, key) ? (value as Record<string, unknown>)[key] : undefined;
  }
  function resolve(expression: string, context: Context): unknown {
    const parts = expression.split(".");
    const first = parts.shift()!;
    let value: unknown;
    if (first === "this") value = context.value;
    else if (first === "@index") value = context.index;
    else value = read(owns(context.value, first) ? context.value : data, first);
    for (const part of parts) value = read(value, part);
    return value;
  }
  function truthy(value: unknown): boolean {
    return value !== "" && value !== 0 && value !== 0n && value !== false
      && value !== null && value !== undefined
      && (!Array.isArray(value) || value.length > 0);
  }
  const escapes: Record<string, string> = {
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  };
  const output: string[] = [];
  function visit(children: Node[], context: Context): void {
    for (const node of children) {
      if (node.kind === "text") {
        output.push(node.text);
        continue;
      }
      const value = resolve(node.path, context);
      if (node.kind === "value") {
        if (value === null || value === undefined) continue;
        if (!["string", "number", "boolean", "bigint"].includes(typeof value)) {
          fail(`Cannot render ${JSON.stringify(node.path)} as scalar text (${Array.isArray(value) ? "array" : typeof value})`, node.offset);
        }
        const text = String(value);
        output.push(node.raw ? text : text.replace(/[&<>"']/g, character => escapes[character]!));
      } else if (node.kind === "if") {
        visit(truthy(value) ? node.body : node.alternate, context);
      } else if (Array.isArray(value) && value.length > 0) {
        for (let index = 0; index < value.length; index++) {
          visit(node.body, { value: value[index], index });
        }
      } else {
        visit(node.alternate, context);
      }
    }
  }
  visit(nodes, { value: data });
  return output.join("");
}
