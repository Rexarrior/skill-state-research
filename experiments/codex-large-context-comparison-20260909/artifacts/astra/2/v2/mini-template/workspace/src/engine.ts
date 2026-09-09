type TextNode = { kind: "text"; value: string };
type ValueNode = { kind: "value"; path: string; raw: boolean; offset: number };
type BlockNode = {
  kind: "if" | "each";
  path: string;
  body: TemplateNode[];
  alternate: TemplateNode[];
  offset: number;
};
type TemplateNode = TextNode | ValueNode | BlockNode;
type Context = { root: unknown; item: unknown; index?: number; inLoop: boolean };

function fail(template: string, offset: number, message: string): never {
  const prefix = template.slice(0, offset);
  const line = prefix.split("\n").length;
  const column = offset - prefix.lastIndexOf("\n");
  throw new Error(`${message} at line ${line}, column ${column}`);
}

function validatePath(template: string, offset: number, path: string): string {
  if (!/^(?:@index|[^\s.{}#/*!]+(?:\.[^\s.{}#/*!]+)*)$/.test(path)) {
    fail(template, offset, `Invalid path ${JSON.stringify(path)}`);
  }
  return path;
}

function parse(template: string): TemplateNode[] {
  const nodes: TemplateNode[] = [];
  const stack: { node: BlockNode; parent: TemplateNode[]; hasElse: boolean }[] = [];
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
    const closing = raw ? "}}}" : "}}";
    const end = template.indexOf(closing, start + (raw ? 3 : 2));
    if (end < 0) fail(template, start, "Unclosed tag");
    const tag = template.slice(start + (raw ? 3 : 2), end).trim();
    cursor = end + closing.length;
    if (!raw && tag.startsWith("!")) continue;
    if (!raw && tag.startsWith("#")) {
      const match = /^#(\S+)(?:\s+([\s\S]*))?$/.exec(tag);
      const kind = match?.[1];
      if (kind !== "if" && kind !== "each") fail(template, start, `Unknown block ${tag}`);
      const path = validatePath(template, start, match?.[2]?.trim() ?? "");
      const node: BlockNode = { kind, path, body: [], alternate: [], offset: start };
      target.push(node);
      stack.push({ node, parent: target, hasElse: false });
      target = node.body;
    } else if (!raw && tag === "else") {
      const frame = stack.at(-1);
      if (!frame) fail(template, start, "else outside a block");
      if (frame.hasElse) fail(template, start, "Duplicate else");
      frame.hasElse = true;
      target = frame.node.alternate;
    } else if (!raw && tag.startsWith("/")) {
      const frame = stack.at(-1);
      if (!frame) fail(template, start, `Unexpected closing tag ${tag}`);
      if (tag !== `/${frame.node.kind}`) {
        fail(template, start, `Mismatched closing tag ${tag}; expected /${frame.node.kind}`);
      }
      stack.pop();
      target = frame.parent;
    } else {
      target.push({ kind: "value", path: validatePath(template, start, tag), raw, offset: start });
    }
  }
  const frame = stack.at(-1);
  if (frame) fail(template, frame.node.offset, `Unclosed ${frame.node.kind} block`);
  return nodes;
}

const missing = Symbol("missing");
function lookup(value: unknown, parts: string[]): unknown | typeof missing {
  for (const part of parts) {
    if (value == null || !Object.prototype.hasOwnProperty.call(value, part)) return missing;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

function resolve(path: string, context: Context): unknown {
  if (path === "@index") return context.index;
  const parts = path.split(".");
  let value: unknown;
  if (parts[0] === "this") {
    value = lookup(context.item, parts.slice(1));
  } else {
    value = context.inLoop ? lookup(context.item, parts) : missing;
    if (value === missing) value = lookup(context.root, parts);
  }
  return value === missing ? undefined : value;
}

function truthy(value: unknown): boolean {
  return Array.isArray(value) ? value.length > 0 : Boolean(value);
}

const entities: Record<string, string> = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
};

/** Render a template, throwing located errors for invalid syntax or non-scalar values. */
export function render(template: string, data: unknown): string {
  const nodes = parse(template);
  const output: string[] = [];
  function visit(children: TemplateNode[], context: Context): void {
    for (const node of children) {
      if (node.kind === "text") {
        output.push(node.value);
        continue;
      }
      const value = resolve(node.path, context);
      if (node.kind === "value") {
        if (value == null) continue;
        if (typeof value === "object" || typeof value === "function") {
          fail(template, node.offset, `Cannot render non-scalar value at path ${JSON.stringify(node.path)}`);
        }
        const text = String(value);
        output.push(node.raw ? text : text.replace(/[&<>"']/g, char => entities[char]!));
      } else if (node.kind === "if") {
        visit(truthy(value) ? node.body : node.alternate, context);
      } else if (Array.isArray(value) && value.length > 0) {
        for (let index = 0; index < value.length; index++) {
          visit(node.body, { root: context.root, item: value[index], index, inLoop: true });
        }
      } else {
        visit(node.alternate, context);
      }
    }
  }
  visit(nodes, { root: data, item: data, inLoop: false });
  return output.join("");
}
