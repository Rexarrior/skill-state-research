type Node = TextNode | ValueNode | IfNode | EachNode;

interface TextNode {
  type: "text";
  value: string;
}

interface ValueNode {
  type: "value";
  path: string;
  escaped: boolean;
  offset: number;
}

interface IfNode {
  type: "if";
  path: string;
  consequent: Node[];
  alternate: Node[];
  offset: number;
}

interface EachNode {
  type: "each";
  path: string;
  body: Node[];
  alternate: Node[];
  offset: number;
}

interface BlockFrame {
  kind: "if" | "each";
  node: IfNode | EachNode;
  inElse: boolean;
  offset: number;
}

interface RenderContext {
  root: unknown;
  current?: unknown;
  index?: number;
  inEach: boolean;
}

interface LookupResult {
  found: boolean;
  value: unknown;
}

/** Render a mini-template using the supplied data value. */
export function render(template: string, data: unknown): string {
  if (typeof template !== "string") {
    throw new TypeError("Template must be a string");
  }

  const nodes = parse(template);
  return renderNodes(nodes, { root: data, inEach: false }, template);
}

function parse(template: string): Node[] {
  const root: Node[] = [];
  const stack: BlockFrame[] = [];
  let output = root;
  let cursor = 0;

  while (cursor < template.length) {
    const open = template.indexOf("{{", cursor);
    if (open === -1) {
      output.push({ type: "text", value: template.slice(cursor) });
      break;
    }

    if (open > cursor) {
      output.push({ type: "text", value: template.slice(cursor, open) });
    }

    if (template.startsWith("{{{", open)) {
      const close = template.indexOf("}}}", open + 3);
      if (close === -1) fail(template, open, "Unclosed triple-brace tag");
      const path = template.slice(open + 3, close).trim();
      validatePath(path, template, open);
      output.push({ type: "value", path, escaped: false, offset: open });
      cursor = close + 3;
      continue;
    }

    const close = template.indexOf("}}", open + 2);
    if (close === -1) fail(template, open, "Unclosed tag");
    const tag = template.slice(open + 2, close).trim();
    cursor = close + 2;

    if (tag.startsWith("!")) continue;

    const opening = /^#(if|each)\s+(.+)$/.exec(tag);
    if (opening) {
      const kind = opening[1] as "if" | "each";
      const path = opening[2].trim();
      validatePath(path, template, open);

      if (kind === "if") {
        const node: IfNode = {
          type: "if",
          path,
          consequent: [],
          alternate: [],
          offset: open,
        };
        output.push(node);
        stack.push({ kind, node, inElse: false, offset: open });
        output = node.consequent;
      } else {
        const node: EachNode = {
          type: "each",
          path,
          body: [],
          alternate: [],
          offset: open,
        };
        output.push(node);
        stack.push({ kind, node, inElse: false, offset: open });
        output = node.body;
      }
      continue;
    }

    if (tag === "else") {
      const frame = stack.at(-1);
      if (!frame) fail(template, open, "`else` used outside a block");
      if (frame.inElse) fail(template, open, "Duplicate `else` in block");
      frame.inElse = true;
      output = frame.node.alternate;
      continue;
    }

    const closing = /^\/(\S+)$/.exec(tag);
    if (closing) {
      const closeKind = closing[1];
      if (closeKind !== "if" && closeKind !== "each") {
        fail(template, open, `Unknown closing block \`${closeKind}\``);
      }
      const frame = stack.at(-1);
      if (!frame) fail(template, open, `Unexpected closing block \`${closeKind}\``);
      if (frame.kind !== closeKind) {
        fail(
          template,
          open,
          `Mismatched closing block: expected \`/${frame.kind}\`, got \`/${closeKind}\``,
        );
      }
      stack.pop();
      const parent = stack.at(-1);
      output = parent
        ? parent.inElse
          ? parent.node.alternate
          : parent.kind === "if"
            ? (parent.node as IfNode).consequent
            : (parent.node as EachNode).body
        : root;
      continue;
    }

    if (tag.startsWith("#")) {
      const name = tag.slice(1).trim().split(/\s+/, 1)[0] || "(empty)";
      fail(template, open, `Unknown or invalid block \`${name}\``);
    }
    if (tag.startsWith("/")) {
      fail(template, open, `Invalid closing block \`${tag}\``);
    }

    validatePath(tag, template, open);
    output.push({ type: "value", path: tag, escaped: true, offset: open });
  }

  const unclosed = stack.at(-1);
  if (unclosed) {
    fail(template, unclosed.offset, `Unclosed \`${unclosed.kind}\` block`);
  }
  return root;
}

function validatePath(path: string, template: string, offset: number): void {
  const segment = "[^.\\s{}]+";
  const valid = new RegExp(`^(?:this(?:\\.${segment})*|@index|${segment}(?:\\.${segment})*)$`);
  if (
    !valid.test(path) ||
    path.startsWith("#") ||
    path.startsWith("/") ||
    (path.startsWith("@") && path !== "@index")
  ) {
    fail(template, offset, path ? `Invalid path \`${path}\`` : "Empty interpolation path");
  }
}

function renderNodes(nodes: Node[], context: RenderContext, template: string): string {
  let result = "";
  for (const node of nodes) {
    switch (node.type) {
      case "text":
        result += node.value;
        break;
      case "value": {
        const value = lookup(node.path, context).value;
        const text = scalarText(value, template, node.offset, node.path);
        result += node.escaped ? escapeHtml(text) : text;
        break;
      }
      case "if": {
        const value = lookup(node.path, context).value;
        result += renderNodes(
          isTruthy(value) ? node.consequent : node.alternate,
          context,
          template,
        );
        break;
      }
      case "each": {
        const value = lookup(node.path, context).value;
        if (!Array.isArray(value) || value.length === 0) {
          result += renderNodes(node.alternate, context, template);
          break;
        }
        for (let index = 0; index < value.length; index++) {
          result += renderNodes(
            node.body,
            { root: context.root, current: value[index], index, inEach: true },
            template,
          );
        }
        break;
      }
    }
  }
  return result;
}

function lookup(path: string, context: RenderContext): LookupResult {
  if (path === "@index") {
    return context.inEach
      ? { found: true, value: context.index }
      : { found: false, value: undefined };
  }

  if (path === "this") {
    return context.inEach
      ? { found: true, value: context.current }
      : { found: true, value: context.root };
  }

  if (path.startsWith("this.")) {
    const base = context.inEach ? context.current : context.root;
    return descend(base, path.slice(5).split("."));
  }

  const parts = path.split(".");
  if (context.inEach) {
    const local = descend(context.current, parts);
    if (local.found) return local;
  }
  return descend(context.root, parts);
}

function descend(base: unknown, parts: string[]): LookupResult {
  let value = base;
  for (const part of parts) {
    if ((typeof value !== "object" || value === null) && typeof value !== "function") {
      return { found: false, value: undefined };
    }
    if (!Object.prototype.hasOwnProperty.call(value, part)) {
      return { found: false, value: undefined };
    }
    value = (value as Record<string, unknown>)[part];
  }
  return { found: true, value };
}

function scalarText(value: unknown, template: string, offset: number, path: string): string {
  if (value === null || value === undefined) return "";
  switch (typeof value) {
    case "string":
      return value;
    case "number":
    case "boolean":
    case "bigint":
    case "symbol":
      return String(value);
    default:
      fail(template, offset, `Value at \`${path}\` is not scalar text`);
  }
}

function isTruthy(value: unknown): boolean {
  if (
    value === null ||
    value === undefined ||
    value === false ||
    value === 0 ||
    value === 0n ||
    value === ""
  ) {
    return false;
  }
  return !Array.isArray(value) || value.length > 0;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      default: return "&#39;";
    }
  });
}

function fail(template: string, offset: number, message: string): never {
  let line = 1;
  let column = 1;
  for (let index = 0; index < offset; index++) {
    if (template.charCodeAt(index) === 10) {
      line++;
      column = 1;
    } else {
      column++;
    }
  }
  throw new Error(`${message} at line ${line}, column ${column}`);
}
