type Location = { line: number; column: number };
type Path = { text: string; parts: string[]; location: Location };
type Node =
  | { kind: "text"; text: string }
  | { kind: "value"; path: Path; raw: boolean }
  | Block;
type Block = {
  kind: "if" | "each";
  path: Path;
  body: Node[];
  alternative: Node[];
};
type Context = { root: unknown; item: unknown; index?: number };

function fail(message: string, location: Location): never {
  throw new Error(`${message} at line ${location.line}, column ${location.column}`);
}

function parse(template: string): Node[] {
  const lines = [0];
  for (let i = 0; i < template.length; i++) {
    if (template[i] === "\n") lines.push(i + 1);
  }
  function locate(offset: number): Location {
    let low = 0;
    let high = lines.length;
    while (low + 1 < high) {
      const mid = (low + high) >>> 1;
      if (lines[mid]! <= offset) low = mid;
      else high = mid;
    }
    return { line: low + 1, column: offset - lines[low]! + 1 };
  }
  function path(text: string, location: Location): Path {
    if (!/^(?:@index|[^\s.{}#!/@]+)(?:\.[^\s.{}#!/@]+)*$/.test(text)) {
      fail(`Invalid path ${JSON.stringify(text)}`, location);
    }
    return { text, parts: text.split("."), location };
  }

  const result: Node[] = [];
  const stack: { block: Block; parent: Node[]; hasElse: boolean }[] = [];
  let target = result;
  let cursor = 0;
  while (cursor < template.length) {
    const start = template.indexOf("{{", cursor);
    if (start === -1) {
      target.push({ kind: "text", text: template.slice(cursor) });
      break;
    }
    if (start > cursor) target.push({ kind: "text", text: template.slice(cursor, start) });
    const location = locate(start);
    const raw = template.startsWith("{{{", start);
    const openingLength = raw ? 3 : 2;
    const end = template.indexOf(raw ? "}}}" : "}}", start + openingLength);
    if (end === -1) fail("Unclosed tag", location);
    const tag = template.slice(start + openingLength, end).trim();
    cursor = end + openingLength;

    if (!raw && tag.startsWith("!")) continue;
    if (!raw && tag.startsWith("#")) {
      const match = /^#(\S+)(?:\s+([\s\S]*))?$/.exec(tag);
      const kind = match?.[1];
      if (kind !== "if" && kind !== "each") fail(`Unknown block ${JSON.stringify(tag)}`, location);
      const block: Block = {
        kind,
        path: path(match?.[2]?.trim() ?? "", location),
        body: [],
        alternative: [],
      };
      target.push(block);
      stack.push({ block, parent: target, hasElse: false });
      target = block.body;
    } else if (!raw && tag === "else") {
      const frame = stack[stack.length - 1];
      if (!frame) fail("else outside a block", location);
      if (frame.hasElse) fail("Duplicate else", location);
      frame.hasElse = true;
      target = frame.block.alternative;
    } else if (!raw && tag.startsWith("/")) {
      const frame = stack[stack.length - 1];
      if (!frame) fail(`Unexpected closing tag ${JSON.stringify(tag)}`, location);
      if (tag !== `/${frame.block.kind}`) {
        fail(`Mismatched closing tag ${JSON.stringify(tag)}; expected /${frame.block.kind}`, location);
      }
      stack.pop();
      target = frame.parent;
    } else {
      target.push({ kind: "value", path: path(tag, location), raw });
    }
  }
  const unclosed = stack[stack.length - 1];
  if (unclosed) fail(`Unclosed ${unclosed.block.kind} block`, unclosed.block.path.location);
  return result;
}

function lookup(value: unknown, parts: string[]): unknown {
  for (const part of parts) {
    if (value == null || !Object.prototype.hasOwnProperty.call(value, part)) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

function resolve(path: Path, context: Context): unknown {
  const [first, ...rest] = path.parts;
  if (first === "this") return lookup(context.item, rest);
  if (first === "@index") return lookup(context.index, rest);
  const local = lookup(context.item, path.parts);
  return local === undefined ? lookup(context.root, path.parts) : local;
}

function truthy(value: unknown): boolean {
  return Array.isArray(value) ? value.length > 0 : Boolean(value);
}

function scalar(value: unknown, path: Path): string {
  if (value == null) return "";
  switch (typeof value) {
    case "string":
    case "number":
    case "boolean":
    case "bigint":
      return String(value);
    default:
      return fail(`Cannot render non-scalar value for path ${JSON.stringify(path.text)} (${Array.isArray(value) ? "array" : typeof value})`, path.location);
  }
}

const entities: Record<string, string> = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
};

/** Render a template with HTML escaping, conditional blocks, and array loops. */
export function render(template: string, data: unknown): string {
  const output: string[] = [];
  function visit(nodes: Node[], context: Context): void {
    for (const node of nodes) {
      if (node.kind === "text") {
        output.push(node.text);
      } else {
        const value = resolve(node.path, context);
        if (node.kind === "value") {
          const text = scalar(value, node.path);
          output.push(node.raw ? text : text.replace(/[&<>"']/g, char => entities[char]!));
        } else if (node.kind === "if") {
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
  }
  visit(parse(template), { root: data, item: data });
  return output.join("");
}
