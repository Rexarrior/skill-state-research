type Location = { line: number; column: number };
type TextNode = { kind: "text"; value: string };
type ValueNode = { kind: "value"; path: string; raw: boolean; at: Location };
type BlockNode = {
  kind: "if" | "each";
  path: string;
  yes: Node[];
  no: Node[];
  at: Location;
};
type Node = TextNode | ValueNode | BlockNode;
type Frame = { block: BlockNode; parent: Node[]; hasElse: boolean };

function fail(message: string, at: Location): never {
  throw new Error(`${message} at line ${at.line}, column ${at.column}`);
}

function checkPath(path: string, at: Location): string {
  if (!/^(?:@index|[^\s.{}#\/!@]+(?:\.[^\s.{}#\/!@]+)*)$/.test(path)) {
    fail(`Invalid path ${JSON.stringify(path)}`, at);
  }
  return path;
}

function parse(template: string): Node[] {
  const result: Node[] = [];
  let target = result;
  const stack: Frame[] = [];
  let offset = 0;
  let line = 1;
  let column = 1;
  function advance(end: number) {
    while (offset < end) {
      if (template[offset++] === "\n") { line++; column = 1; }
      else column++;
    }
  }
  while (offset < template.length) {
    const start = template.indexOf("{{", offset);
    if (start < 0) {
      target.push({ kind: "text", value: template.slice(offset) });
      break;
    }
    if (start > offset) target.push({ kind: "text", value: template.slice(offset, start) });
    advance(start);
    const at = { line, column };
    const raw = template.startsWith("{{{", start);
    const openLength = raw ? 3 : 2;
    const closing = raw ? "}}}" : "}}";
    const end = template.indexOf(closing, start + openLength);
    if (end < 0) fail("Unclosed tag", at);
    const tag = template.slice(start + openLength, end).trim();
    advance(end + closing.length);
    if (raw) {
      target.push({ kind: "value", path: checkPath(tag, at), raw: true, at });
    } else if (tag.startsWith("!")) {
      continue;
    } else if (tag.startsWith("#")) {
      const match = /^#(if|each)\s+(.+)$/.exec(tag);
      if (!match) fail(`Unknown or invalid block ${JSON.stringify(tag)}`, at);
      const block: BlockNode = {
        kind: match[1] as "if" | "each", path: checkPath(match[2]!.trim(), at), yes: [], no: [], at,
      };
      target.push(block);
      stack.push({ block, parent: target, hasElse: false });
      target = block.yes;
    } else if (tag === "else") {
      const frame = stack[stack.length - 1];
      if (!frame) fail("else outside a block", at);
      if (frame.hasElse) fail("Duplicate else", at);
      frame.hasElse = true;
      target = frame.block.no;
    } else if (tag.startsWith("/")) {
      const frame = stack[stack.length - 1];
      if (!frame) fail(`Unexpected closing tag ${JSON.stringify(tag)}`, at);
      if (tag !== `/${frame.block.kind}`) {
        fail(`Mismatched closing tag ${JSON.stringify(tag)}; expected /${frame.block.kind}`, at);
      }
      stack.pop();
      target = frame.parent;
    } else {
      target.push({ kind: "value", path: checkPath(tag, at), raw: false, at });
    }
  }
  const unclosed = stack[stack.length - 1];
  if (unclosed) fail(`Unclosed ${unclosed.block.kind} block`, unclosed.block.at);
  return result;
}

type Scope = { root: unknown; current: unknown; index?: number };
const missing = Symbol("missing");
function lookup(value: unknown, parts: string[]): unknown {
  for (const part of parts) {
    if (value == null || !Object.prototype.hasOwnProperty.call(value, part)) return missing;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}
function resolve(path: string, scope: Scope): unknown {
  if (path === "@index") return scope.index;
  const parts = path.split(".");
  if (parts[0] === "this") {
    const value = lookup(scope.current, parts.slice(1));
    return value === missing ? undefined : value;
  }
  const local = lookup(scope.current, parts);
  if (local !== missing) return local;
  const root = lookup(scope.root, parts);
  return root === missing ? undefined : root;
}
function truthy(value: unknown): boolean {
  return Array.isArray(value) ? value.length > 0 : Boolean(value);
}
const entities: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
function scalar(value: unknown, node: ValueNode): string {
  if (value == null) return "";
  if (!["string", "number", "boolean", "bigint"].includes(typeof value)) {
    fail(`Cannot render ${Array.isArray(value) ? "array" : typeof value} value for ${JSON.stringify(node.path)} as scalar text`, node.at);
  }
  const text = String(value);
  return node.raw ? text : text.replace(/[&<>"']/g, character => entities[character]!);
}
function evaluate(nodes: Node[], scope: Scope, output: string[]): void {
  for (const node of nodes) {
    if (node.kind === "text") { output.push(node.value); continue; }
    const value = resolve(node.path, scope);
    if (node.kind === "value") output.push(scalar(value, node));
    else if (node.kind === "if") evaluate(truthy(value) ? node.yes : node.no, scope, output);
    else if (Array.isArray(value) && value.length > 0) {
      for (let index = 0; index < value.length; index++) {
        evaluate(node.yes, { root: scope.root, current: value[index], index }, output);
      }
    } else evaluate(node.no, scope, output);
  }
}

/** Render a template; invalid structure or non-scalar interpolation throws. */
export function render(template: string, data: unknown): string {
  const nodes = parse(template);
  const output: string[] = [];
  evaluate(nodes, { root: data, current: data }, output);
  return output.join("");
}
