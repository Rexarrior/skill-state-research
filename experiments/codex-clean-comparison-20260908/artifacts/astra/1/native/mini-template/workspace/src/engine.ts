type Location = { line: number; column: number };
type TextNode = { kind: "text"; text: string };
type ValueNode = { kind: "value"; path: string; raw: boolean; at: Location };
type BlockNode = {
  kind: "if" | "each";
  path: string;
  body: Node[];
  alternative: Node[];
  at: Location;
};
type Node = TextNode | ValueNode | BlockNode;
type Context = { root: unknown; item?: unknown; index?: number };

function fail(message: string, at: Location): never {
  throw new Error(`${message} at line ${at.line}, column ${at.column}`);
}

function parse(template: string): Node[] {
  const starts = [0];
  for (let i = 0; i < template.length; i++) {
    if (template[i] === "\n") starts.push(i + 1);
  }
  const location = (offset: number): Location => {
    let low = 0;
    let high = starts.length;
    while (low + 1 < high) {
      const mid = (low + high) >>> 1;
      if (starts[mid] <= offset) low = mid;
      else high = mid;
    }
    return { line: low + 1, column: offset - starts[low] + 1 };
  };
  const checkPath = (path: string, at: Location) => {
    if (!path || path.split(".").some(part => !part || /[\s{}]/u.test(part))) {
      fail(`Invalid or missing path ${JSON.stringify(path)}`, at);
    }
  };
  const result: Node[] = [];
  const stack: { node: BlockNode; parent: Node[]; sawElse: boolean }[] = [];
  let target = result;
  let cursor = 0;
  while (cursor < template.length) {
    const start = template.indexOf("{{", cursor);
    if (start === -1) {
      target.push({ kind: "text", text: template.slice(cursor) });
      break;
    }
    if (start > cursor) target.push({ kind: "text", text: template.slice(cursor, start) });
    const at = location(start);
    const raw = template.startsWith("{{{", start);
    const openerLength = raw ? 3 : 2;
    const closer = raw ? "}}}" : "}}";
    const end = template.indexOf(closer, start + openerLength);
    if (end === -1) fail("Unclosed tag", at);
    const tag = template.slice(start + openerLength, end).trim();
    cursor = end + closer.length;

    if (!raw && tag.startsWith("!")) continue;
    if (!raw && tag.startsWith("#")) {
      const match = /^#([^\s]+)(?:\s+([\s\S]*))?$/.exec(tag);
      const kind = match?.[1];
      if (kind !== "if" && kind !== "each") fail(`Unknown block ${JSON.stringify(kind ?? tag)}`, at);
      const path = (match?.[2] ?? "").trim();
      checkPath(path, at);
      const node: BlockNode = { kind, path, body: [], alternative: [], at };
      target.push(node);
      stack.push({ node, parent: target, sawElse: false });
      target = node.body;
    } else if (!raw && tag === "else") {
      const frame = stack.at(-1);
      if (!frame) fail("else outside a block", at);
      if (frame.sawElse) fail("Duplicate else", at);
      frame.sawElse = true;
      target = frame.node.alternative;
    } else if (!raw && tag.startsWith("/")) {
      const frame = stack.at(-1);
      if (!frame) fail(`Unexpected closing tag ${JSON.stringify(tag)}`, at);
      if (tag !== `/${frame.node.kind}`) {
        fail(`Mismatched closing tag ${JSON.stringify(tag)}; expected /${frame.node.kind}`, at);
      }
      stack.pop();
      target = frame.parent;
    } else {
      checkPath(tag, at);
      target.push({ kind: "value", path: tag, raw, at });
    }
  }
  const unclosed = stack.at(-1);
  if (unclosed) fail(`Unclosed ${unclosed.node.kind} block`, unclosed.node.at);
  return result;
}

const MISSING = Symbol("missing");

// Own properties only: templates cannot traverse the prototype chain.
function lookup(value: unknown, parts: string[]): unknown | typeof MISSING {
  for (const part of parts) {
    if (value == null || !Object.prototype.hasOwnProperty.call(value, part)) return MISSING;
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
    value = context.index === undefined ? MISSING : lookup(context.item, parts);
    if (value === MISSING) value = lookup(context.root, parts);
  }
  return value === MISSING ? undefined : value;
}

function truthy(value: unknown): boolean {
  return Array.isArray(value) ? value.length > 0 : Boolean(value);
}

function scalar(value: unknown, node: ValueNode): string {
  if (value == null) return "";
  if (typeof value === "object" || typeof value === "function") {
    fail(`Cannot render ${JSON.stringify(node.path)} as scalar text (${Array.isArray(value) ? "array" : typeof value})`, node.at);
  }
  return String(value);
}

const escapes: Record<string, string> = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
};

/** Render a template with HTML escaping, conditionals, and array iteration. */
export function render(template: string, data: unknown): string {
  const nodes = parse(template);
  const output: string[] = [];
  const visit = (nodes: Node[], context: Context): void => {
    for (const node of nodes) {
      if (node.kind === "text") {
        output.push(node.text);
      } else if (node.kind === "value") {
        const text = scalar(resolve(node.path, context), node);
        output.push(node.raw ? text : text.replace(/[&<>"']/g, char => escapes[char]));
      } else {
        const value = resolve(node.path, context);
        if (node.kind === "if") {
          visit(truthy(value) ? node.body : node.alternative, context);
        } else if (Array.isArray(value) && value.length > 0) {
          for (let index = 0; index < value.length; index++) {
            visit(node.body, { root: context.root, item: value[index], index });
          }
        } else {
          visit(node.alternative, context);
        }
      }
    }
  };
  visit(nodes, { root: data });
  return output.join("");
}
