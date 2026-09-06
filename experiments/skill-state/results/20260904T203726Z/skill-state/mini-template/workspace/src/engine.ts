type Node = TextNode | InterpolationNode | BlockNode;

type TextNode = { type: "text"; value: string };
type InterpolationNode = { type: "interpolation"; path: string; escaped: boolean };
type BlockNode = {
  type: "block";
  kind: "if" | "each";
  path: string;
  body: Node[];
  alternate: Node[] | null;
  line: number;
  column: number;
};

type Frame = { nodes: Node[]; block: BlockNode | null; inElse: boolean };
type Context = { root: unknown; value: unknown; index?: number };

const position = (source: string, offset: number): string => {
  const before = source.slice(0, offset);
  const line = before.split("\n").length;
  const column = offset - before.lastIndexOf("\n");
  return `line ${line}, column ${column}`;
};

const parse = (template: string): Node[] => {
  const root: Node[] = [];
  const stack: Frame[] = [{ nodes: root, block: null, inElse: false }];
  let cursor = 0;

  const current = (): Frame => stack[stack.length - 1]!;
  const addText = (value: string): void => {
    if (value) current().nodes.push({ type: "text", value });
  };

  while (cursor < template.length) {
    const start = template.indexOf("{{", cursor);
    if (start < 0) {
      addText(template.slice(cursor));
      break;
    }
    addText(template.slice(cursor, start));

    const triple = template.startsWith("{{{", start);
    const close = triple ? "}}}" : "}}";
    const end = template.indexOf(close, start + (triple ? 3 : 2));
    if (end < 0) throw new Error(`Unclosed tag at ${position(template, start)}`);

    const raw = template.slice(start + (triple ? 3 : 2), end).trim();
    const tagPosition = position(template, start);
    cursor = end + close.length;

    if (triple) {
      if (!raw) throw new Error(`Empty interpolation at ${tagPosition}`);
      current().nodes.push({ type: "interpolation", path: raw, escaped: false });
      continue;
    }
    if (raw.startsWith("!")) continue;
    if (raw === "else") {
      const frame = current();
      if (!frame.block) throw new Error(`'else' outside a block at ${tagPosition}`);
      if (frame.inElse) throw new Error(`Duplicate 'else' at ${tagPosition}`);
      frame.inElse = true;
      frame.block.alternate = [];
      frame.nodes = frame.block.alternate;
      continue;
    }
    if (raw.startsWith("#")) {
      const match = /^#(if|each)\s+(.+)$/.exec(raw);
      if (!match) throw new Error(`Invalid block at ${tagPosition}`);
      const block: BlockNode = {
        type: "block", kind: match[1] as "if" | "each", path: match[2].trim(),
        body: [], alternate: null,
        line: Number(tagPosition.match(/line (\d+)/)![1]),
        column: Number(tagPosition.match(/column (\d+)/)![1]),
      };
      current().nodes.push(block);
      stack.push({ nodes: block.body, block, inElse: false });
      continue;
    }
    if (raw.startsWith("/")) {
      const kind = raw.slice(1).trim();
      const frame = current();
      if (!frame.block) throw new Error(`Unexpected close '${kind}' at ${tagPosition}`);
      if (kind !== frame.block.kind) {
        throw new Error(`Mismatched close '${kind}' for '${frame.block.kind}' at ${tagPosition}`);
      }
      stack.pop();
      continue;
    }
    if (!raw) throw new Error(`Empty interpolation at ${tagPosition}`);
    current().nodes.push({ type: "interpolation", path: raw, escaped: true });
  }

  if (stack.length > 1) {
    const block = current().block!;
    throw new Error(`Unclosed '${block.kind}' block at line ${block.line}, column ${block.column}`);
  }
  return root;
};

const resolve = (path: string, context: Context): unknown => {
  if (path === "this") return context.value;
  if (path === "@index") return context.index;
  const parts = path.split(".");
  let value: unknown = context.root;
  for (const part of parts) {
    if (value === null || value === undefined || (typeof value !== "object" && typeof value !== "function")) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
};

const isTruthy = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.length > 0;
  return Boolean(value);
};

const stringify = (value: unknown): string => {
  if (value === null || value === undefined) return "";
  if (typeof value === "object" || typeof value === "function") {
    throw new Error("Cannot render an object or function as scalar text");
  }
  return String(value);
};

const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[character]!);

const renderNodes = (nodes: Node[], context: Context): string => nodes.map((node) => {
  if (node.type === "text") return node.value;
  if (node.type === "interpolation") {
    const value = stringify(resolve(node.path, context));
    return node.escaped ? escapeHtml(value) : value;
  }
  const value = resolve(node.path, context);
  if (node.kind === "if") return renderNodes(isTruthy(value) ? node.body : (node.alternate ?? []), context);
  if (!Array.isArray(value)) return renderNodes(node.alternate ?? [], context);
  return value.length === 0
    ? renderNodes(node.alternate ?? [], context)
    : value.map((item, index) => renderNodes(node.body, { root: context.root, value: item, index })).join("");
}).join("");

/** Render a template using the supported interpolation and block syntax. */
export const render = (template: string, data: unknown): string =>
  renderNodes(parse(template), { root: data, value: data });
