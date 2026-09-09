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
type Frame = { node: BlockNode; hasElse: boolean };
type Context = { value: unknown; index?: number };

function fail(message: string, at: Location): never {
  throw new Error(`${message} at line ${at.line}, column ${at.column}`);
}

function parse(template: string): Node[] {
  const nodes: Node[] = [];
  const stack: Frame[] = [];
  let target = nodes;
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

  function path(value: string, at: Location): string {
    if (!/^[^.\s{}#/!]+(?:\.[^.\s{}#/!]+)*$/.test(value)) {
      fail(`Invalid path ${JSON.stringify(value)}`, at);
    }
    return value;
  }

  while (offset < template.length) {
    const start = template.indexOf("{{", offset);
    if (start === -1) {
      target.push({ kind: "text", value: template.slice(offset) });
      break;
    }
    if (start > offset) {
      target.push({ kind: "text", value: template.slice(offset, start) });
      advance(start);
    }
    const at = { line, column };
    const raw = template.startsWith("{{{", start);
    const openerLength = raw ? 3 : 2;
    const closer = raw ? "}}}" : "}}";
    const end = template.indexOf(closer, start + openerLength);
    if (end === -1) fail("Unclosed tag", at);
    const tag = template.slice(start + openerLength, end).trim();
    advance(end + closer.length);

    if (!raw && tag.startsWith("!")) continue;
    if (!raw && tag.startsWith("#")) {
      const match = /^#(\S+)(?:\s+([\s\S]*))?$/.exec(tag);
      const kind = match?.[1];
      if (kind !== "if" && kind !== "each") {
        fail(`Unknown block ${JSON.stringify(kind ?? tag)}`, at);
      }
      const node: BlockNode = {
        kind,
        path: path(match?.[2]?.trim() ?? "", at),
        body: [],
        alternate: [],
        at,
      };
      target.push(node);
      stack.push({ node, hasElse: false });
      target = node.body;
    } else if (!raw && tag === "else") {
      const frame = stack[stack.length - 1];
      if (!frame) fail("else outside a block", at);
      if (frame.hasElse) fail("Duplicate else", at);
      frame.hasElse = true;
      target = frame.node.alternate;
    } else if (!raw && tag.startsWith("/")) {
      const name = tag.slice(1).trim();
      const frame = stack[stack.length - 1];
      if (!frame) fail(`Unexpected closing tag ${JSON.stringify(tag)}`, at);
      if (name !== frame.node.kind) {
        fail(`Mismatched closing tag ${JSON.stringify(tag)}; expected /${frame.node.kind}`, at);
      }
      stack.pop();
      const parent = stack[stack.length - 1];
      target = parent ? (parent.hasElse ? parent.node.alternate : parent.node.body) : nodes;
    } else {
      target.push({ kind: "value", path: path(tag, at), raw, at });
    }
  }
  if (stack.length) {
    const { node } = stack[stack.length - 1]!;
    fail(`Unclosed ${node.kind} block`, node.at);
  }
  return nodes;
}

const missing = Symbol("missing");

function lookup(value: unknown, parts: string[]): unknown {
  for (const part of parts) {
    if (value === null || value === undefined ||
        !Object.prototype.hasOwnProperty.call(value, part)) return missing;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

function resolve(path: string, root: unknown, context: Context): unknown {
  const parts = path.split(".");
  if (parts[0] === "this") return lookup(context.value, parts.slice(1));
  if (parts[0] === "@index") return lookup(context.index, parts.slice(1));
  const local = lookup(context.value, parts);
  return local === missing ? lookup(root, parts) : local;
}

function truthy(value: unknown): boolean {
  return value !== missing && value !== null && value !== undefined &&
    value !== "" && value !== 0 && value !== 0n && value !== false &&
    (!Array.isArray(value) || value.length > 0);
}

function scalar(value: unknown, node: ValueNode): string {
  if (value === missing || value === null || value === undefined) return "";
  if (typeof value === "object" || typeof value === "function" || typeof value === "symbol") {
    fail(`Cannot render ${JSON.stringify(node.path)} as scalar text (${Array.isArray(value) ? "array" : typeof value})`, node.at);
  }
  return String(value);
}

const escapes: Record<string, string> = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
};

/** Render a template with own-property paths and HTML escaping by default. */
export function render(template: string, data: unknown): string {
  const nodes = parse(template);
  const output: string[] = [];

  function visit(nodes: Node[], context: Context): void {
    for (const node of nodes) {
      if (node.kind === "text") {
        output.push(node.value);
        continue;
      }
      const value = resolve(node.path, data, context);
      if (node.kind === "value") {
        const text = scalar(value, node);
        output.push(node.raw ? text : text.replace(/[&<>"']/g, char => escapes[char]!));
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
