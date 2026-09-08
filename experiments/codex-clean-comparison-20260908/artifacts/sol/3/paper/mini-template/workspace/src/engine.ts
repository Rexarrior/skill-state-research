type TextNode = { type: "text"; value: string };
type ValueNode = { type: "value"; path: string; escaped: boolean; offset: number };
type BlockNode = {
  type: "if" | "each";
  path: string;
  truthy: Node[];
  falsy: Node[];
  offset: number;
};
type Node = TextNode | ValueNode | BlockNode;

type Frame = { block: BlockNode; parent: Node[]; inElse: boolean };
type Context = { root: unknown; current: unknown; index?: number; inEach: boolean };

function location(template: string, offset: number): string {
  const before = template.slice(0, offset);
  const line = before.split("\n").length;
  const lastNewline = before.lastIndexOf("\n");
  return `line ${line}, column ${offset - lastNewline}`;
}

function syntaxError(template: string, offset: number, message: string): never {
  throw new Error(`${message} at ${location(template, offset)}`);
}

function parse(template: string): Node[] {
  const root: Node[] = [];
  const stack: Frame[] = [];
  let target = root;
  let cursor = 0;

  while (cursor < template.length) {
    const open = template.indexOf("{{", cursor);
    if (open === -1) {
      target.push({ type: "text", value: template.slice(cursor) });
      break;
    }
    if (open > cursor) target.push({ type: "text", value: template.slice(cursor, open) });

    const triple = template.startsWith("{{{", open);
    const closeToken = triple ? "}}}" : "}}";
    const contentStart = open + (triple ? 3 : 2);
    const close = template.indexOf(closeToken, contentStart);
    if (close === -1) syntaxError(template, open, "Unclosed tag");

    const raw = template.slice(contentStart, close).trim();
    cursor = close + closeToken.length;
    if (!raw) syntaxError(template, open, "Empty tag");

    if (triple) {
      target.push({ type: "value", path: raw, escaped: false, offset: open });
      continue;
    }
    if (raw.startsWith("!")) continue;

    if (raw.startsWith("#")) {
      const match = raw.match(/^#(if|each)(?:\s+(.+))$/);
      if (!match) syntaxError(template, open, `Unknown or malformed block '${raw}'`);
      const block: BlockNode = {
        type: match[1] as "if" | "each",
        path: match[2]!.trim(),
        truthy: [],
        falsy: [],
        offset: open,
      };
      if (!block.path) syntaxError(template, open, `Missing path for ${block.type}`);
      target.push(block);
      stack.push({ block, parent: target, inElse: false });
      target = block.truthy;
      continue;
    }

    if (raw === "else") {
      const frame = stack.at(-1);
      if (!frame) syntaxError(template, open, "'else' outside a block");
      if (frame.inElse) syntaxError(template, open, "Duplicate 'else'");
      frame.inElse = true;
      target = frame.block.falsy;
      continue;
    }

    if (raw.startsWith("/")) {
      const name = raw.slice(1).trim();
      const frame = stack.at(-1);
      if (!frame) syntaxError(template, open, `Unexpected closing block '${name}'`);
      if (name !== frame.block.type) {
        syntaxError(template, open, `Mismatched closing block '${name}'; expected '${frame.block.type}'`);
      }
      stack.pop();
      target = frame.parent;
      continue;
    }

    target.push({ type: "value", path: raw, escaped: true, offset: open });
  }

  const frame = stack.at(-1);
  if (frame) syntaxError(template, frame.block.offset, `Unclosed '${frame.block.type}' block`);
  return root;
}

const MISSING = Symbol("missing");

function property(value: unknown, key: string): unknown | typeof MISSING {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") return MISSING;
  return Object.prototype.hasOwnProperty.call(value, key)
    ? (value as Record<string, unknown>)[key]
    : MISSING;
}

function descend(base: unknown, parts: string[]): unknown | typeof MISSING {
  let value: unknown | typeof MISSING = base;
  for (const part of parts) {
    if (value === MISSING) return MISSING;
    value = property(value, part);
  }
  return value;
}

function resolve(path: string, context: Context): unknown | typeof MISSING {
  if (path === "this") return context.inEach ? context.current : MISSING;
  if (path === "@index") return context.inEach ? context.index : MISSING;
  if (path.startsWith("this.")) {
    return context.inEach ? descend(context.current, path.slice(5).split(".")) : MISSING;
  }
  const parts = path.split(".");
  if (parts.some((part) => part.length === 0)) return MISSING;
  if (context.inEach) {
    const local = descend(context.current, parts);
    if (local !== MISSING) return local;
  }
  return descend(context.root, parts);
}

function truthy(value: unknown | typeof MISSING): boolean {
  if (value === MISSING || value === null || value === undefined || value === false || value === 0 || value === "") {
    return false;
  }
  return !Array.isArray(value) || value.length > 0;
}

function scalar(value: unknown | typeof MISSING, template: string, offset: number): string {
  if (value === MISSING || value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  throw new Error(`Cannot render ${Array.isArray(value) ? "an array" : typeof value} as scalar text at ${location(template, offset)}`);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]!);
}

function renderNodes(nodes: Node[], context: Context, template: string): string {
  let output = "";
  for (const node of nodes) {
    if (node.type === "text") {
      output += node.value;
    } else if (node.type === "value") {
      const text = scalar(resolve(node.path, context), template, node.offset);
      output += node.escaped ? escapeHtml(text) : text;
    } else if (node.type === "if") {
      const branch = truthy(resolve(node.path, context)) ? node.truthy : node.falsy;
      output += renderNodes(branch, context, template);
    } else {
      const value = resolve(node.path, context);
      if (Array.isArray(value) && value.length > 0) {
        for (let index = 0; index < value.length; index++) {
          output += renderNodes(node.truthy, {
            root: context.root,
            current: value[index],
            index,
            inEach: true,
          }, template);
        }
      } else {
        output += renderNodes(node.falsy, context, template);
      }
    }
  }
  return output;
}

export function render(template: string, data: unknown): string {
  const nodes = parse(template);
  return renderNodes(nodes, { root: data, current: data, inEach: false }, template);
}
