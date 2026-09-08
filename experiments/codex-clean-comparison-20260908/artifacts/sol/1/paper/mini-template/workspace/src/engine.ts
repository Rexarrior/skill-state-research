type Location = { line: number; column: number };

type Node =
  | { kind: "text"; value: string }
  | { kind: "value"; path: string; escaped: boolean; location: Location }
  | {
      kind: "block";
      block: "if" | "each";
      path: string;
      body: Node[];
      alternate: Node[];
      location: Location;
    };

type Frame = Extract<Node, { kind: "block" }> & {
  parent: Node[];
  inElse: boolean;
};

const forbiddenKeys = new Set(["__proto__", "prototype", "constructor"]);

function locationAt(source: string, offset: number): Location {
  let line = 1;
  let column = 1;
  for (let i = 0; i < offset; i++) {
    if (source.charCodeAt(i) === 10) {
      line++;
      column = 1;
    } else {
      column++;
    }
  }
  return { line, column };
}

function syntaxError(message: string, location: Location): Error {
  return new Error(`${message} at line ${location.line}, column ${location.column}`);
}

function parse(template: string): Node[] {
  const root: Node[] = [];
  const stack: Frame[] = [];
  let current = root;
  let offset = 0;

  while (offset < template.length) {
    const start = template.indexOf("{{", offset);
    if (start === -1) {
      current.push({ kind: "text", value: template.slice(offset) });
      break;
    }
    if (start > offset) {
      current.push({ kind: "text", value: template.slice(offset, start) });
    }

    const triple = template.startsWith("{{{", start);
    const close = triple ? "}}}" : "}}";
    const contentStart = start + (triple ? 3 : 2);
    const end = template.indexOf(close, contentStart);
    const location = locationAt(template, start);
    if (end === -1) {
      throw syntaxError("Unclosed tag", location);
    }
    const content = template.slice(contentStart, end).trim();
    offset = end + close.length;

    if (triple) {
      if (!content) throw syntaxError("Empty interpolation", location);
      current.push({ kind: "value", path: content, escaped: false, location });
      continue;
    }
    if (content.startsWith("!")) continue;

    if (content === "else") {
      const frame = stack[stack.length - 1];
      if (!frame) throw syntaxError("else outside a block", location);
      if (frame.inElse) throw syntaxError("Duplicate else", location);
      frame.inElse = true;
      current = frame.alternate;
      continue;
    }

    if (content.startsWith("#")) {
      const match = /^#(if|each)(?:\s+)(.+)$/.exec(content);
      if (!match) {
        const name = content.slice(1).split(/\s/, 1)[0] || "(empty)";
        throw syntaxError(`Unknown or malformed block ${name}`, location);
      }
      const node: Extract<Node, { kind: "block" }> = {
        kind: "block",
        block: match[1] as "if" | "each",
        path: match[2].trim(),
        body: [],
        alternate: [],
        location,
      };
      if (!node.path) throw syntaxError(`Missing path for ${node.block}`, location);
      current.push(node);
      stack.push({ ...node, parent: current, inElse: false });
      current = node.body;
      continue;
    }

    if (content.startsWith("/")) {
      const name = content.slice(1).trim();
      const frame = stack[stack.length - 1];
      if (!frame) throw syntaxError(`Closing ${name || "block"} without an open block`, location);
      if (name !== frame.block) {
        throw syntaxError(`Mismatched close: expected /${frame.block}, got /${name}`, location);
      }
      stack.pop();
      current = frame.parent;
      continue;
    }

    if (!content) throw syntaxError("Empty interpolation", location);
    current.push({ kind: "value", path: content, escaped: true, location });
  }

  const unclosed = stack[stack.length - 1];
  if (unclosed) throw syntaxError(`Unclosed ${unclosed.block} block`, unclosed.location);
  return root;
}

type Context = { value: unknown; index: number };

function property(value: unknown, key: string): { found: boolean; value: unknown } {
  if (value === null || value === undefined || forbiddenKeys.has(key)) {
    return { found: false, value: undefined };
  }
  if ((typeof value !== "object" && typeof value !== "function") || !(key in value)) {
    return { found: false, value: undefined };
  }
  return { found: true, value: (value as Record<string, unknown>)[key] };
}

function walk(base: unknown, parts: string[]): { found: boolean; value: unknown } {
  let value = base;
  for (const part of parts) {
    const result = property(value, part);
    if (!result.found) return result;
    value = result.value;
  }
  return { found: true, value };
}

function resolve(path: string, root: unknown, contexts: Context[]): unknown {
  if (path === "this") return contexts.length ? contexts[contexts.length - 1].value : root;
  if (path === "@index") return contexts.length ? contexts[contexts.length - 1].index : undefined;

  const parts = path.split(".");
  if (parts.some((part) => !part)) return undefined;
  if (parts[0] === "this") {
    const base = contexts.length ? contexts[contexts.length - 1].value : root;
    return walk(base, parts.slice(1)).value;
  }

  if (contexts.length) {
    const local = walk(contexts[contexts.length - 1].value, parts);
    if (local.found) return local.value;
  }
  return walk(root, parts).value;
}

function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return value !== "" && value !== 0 && value !== false && value !== null && value !== undefined;
}

function scalar(value: unknown, path: string, location: Location): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  throw syntaxError(`Value at ${path} cannot be rendered as scalar text`, location);
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

function renderNodes(nodes: Node[], root: unknown, contexts: Context[]): string {
  let output = "";
  for (const node of nodes) {
    if (node.kind === "text") {
      output += node.value;
    } else if (node.kind === "value") {
      const text = scalar(resolve(node.path, root, contexts), node.path, node.location);
      output += node.escaped ? escapeHtml(text) : text;
    } else {
      const value = resolve(node.path, root, contexts);
      if (node.block === "if") {
        output += renderNodes(truthy(value) ? node.body : node.alternate, root, contexts);
      } else if (Array.isArray(value) && value.length > 0) {
        for (let index = 0; index < value.length; index++) {
          output += renderNodes(node.body, root, [...contexts, { value: value[index], index }]);
        }
      } else {
        output += renderNodes(node.alternate, root, contexts);
      }
    }
  }
  return output;
}

/** Render a Mini Template string with the supplied data. */
export function render(template: string, data: unknown): string {
  return renderNodes(parse(template), data, []);
}
