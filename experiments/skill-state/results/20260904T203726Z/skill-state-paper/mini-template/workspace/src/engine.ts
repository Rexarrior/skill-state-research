type Node = TextNode | InterpolationNode | BlockNode;

interface TextNode {
  type: "text";
  value: string;
}

interface InterpolationNode {
  type: "interpolation";
  path: string;
  escaped: boolean;
}

interface BlockNode {
  type: "block";
  kind: "if" | "each";
  path: string;
  body: Node[];
  alternate: Node[];
}

interface Frame {
  nodes: Node[];
  thisValue: unknown;
  index?: number;
}

interface OpenBlock {
  node: BlockNode;
  parent: Node[];
  elseSeen: boolean;
}

function position(template: string, offset: number): string {
  const before = template.slice(0, offset);
  const line = before.split("\n").length;
  const column = offset - before.lastIndexOf("\n");
  return `line ${line}, column ${column}`;
}

function fail(template: string, offset: number, message: string): never {
  throw new Error(`${message} at ${position(template, offset)}`);
}

function parse(template: string): Node[] {
  const root: Node[] = [];
  let current = root;
  const stack: OpenBlock[] = [];
  let cursor = 0;

  while (cursor < template.length) {
    const start = template.indexOf("{{", cursor);
    if (start === -1) {
      current.push({ type: "text", value: template.slice(cursor) });
      break;
    }
    if (start > cursor) current.push({ type: "text", value: template.slice(cursor, start) });

    const triple = template.startsWith("{{{", start);
    const close = triple ? "}}}" : "}}";
    const end = template.indexOf(close, start + (triple ? 3 : 2));
    if (end === -1) fail(template, start, "Unclosed tag");

    const raw = template.slice(start + (triple ? 3 : 2), end).trim();
    cursor = end + close.length;
    if (!raw || raw.startsWith("!")) continue;

    if (raw === "else") {
      const open = stack.at(-1);
      if (!open) fail(template, start, "else outside a block");
      if (open.elseSeen) fail(template, start, "Duplicate else");
      open.elseSeen = true;
      current = open.node.alternate;
      continue;
    }

    if (raw.startsWith("#")) {
      const [kind, ...pathParts] = raw.slice(1).trim().split(/\s+/);
      const path = pathParts.join(" ");
      if ((kind !== "if" && kind !== "each") || !path) {
        fail(template, start, `Unknown or malformed block '${raw}'`);
      }
      const node: BlockNode = { type: "block", kind, path, body: [], alternate: [] };
      current.push(node);
      stack.push({ node, parent: current, elseSeen: false });
      current = node.body;
      continue;
    }

    if (raw.startsWith("/")) {
      const kind = raw.slice(1).trim();
      const open = stack.pop();
      if (!open) fail(template, start, `Unexpected closing block '${kind}'`);
      if (kind !== open.node.kind) {
        fail(template, start, `Mismatched closing block '${kind}', expected '${open.node.kind}'`);
      }
      current = open.parent;
      continue;
    }

    current.push({ type: "interpolation", path: raw, escaped: !triple });
  }

  const open = stack.at(-1);
  if (open) fail(template, template.length, `Unclosed block '${open.node.kind}'`);
  return root;
}

function getPath(value: unknown, path: string): unknown {
  if (!path) return undefined;
  let current = value;
  for (const segment of path.split(".")) {
    if (current === null || current === undefined ||
      (typeof current !== "object" && typeof current !== "function")) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function resolve(path: string, frame: Frame, root: unknown): unknown {
  if (path === "this") return frame.thisValue;
  if (path === "@index") return frame.index;
  const local = getPath(frame.thisValue, path);
  return local === undefined ? getPath(root, path) : local;
}

function isTruthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return Boolean(value);
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object" || typeof value === "function") {
    throw new Error("Cannot render an object or function as scalar text");
  }
  return String(value);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]!);
}

function renderNodes(nodes: Node[], frame: Frame, root: unknown): string {
  let output = "";
  for (const node of nodes) {
    if (node.type === "text") output += node.value;
    else if (node.type === "interpolation") {
      const value = stringify(resolve(node.path, frame, root));
      output += node.escaped ? escapeHtml(value) : value;
    } else {
      const value = resolve(node.path, frame, root);
      if (node.kind === "if") output += renderNodes(isTruthy(value) ? node.body : node.alternate, frame, root);
      else if (Array.isArray(value) && value.length > 0) {
        value.forEach((item, index) => { output += renderNodes(node.body, { nodes: [], thisValue: item, index }, root); });
      } else output += renderNodes(node.alternate, frame, root);
    }
  }
  return output;
}

/** Renders a Mini Template string using the supplied root data object. */
export function render(template: string, data: unknown): string {
  return renderNodes(parse(template), { nodes: [], thisValue: data }, data);
}
