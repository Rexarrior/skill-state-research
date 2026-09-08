type Node = TextNode | ValueNode | BlockNode;

interface TextNode {
  kind: "text";
  value: string;
}

interface ValueNode {
  kind: "value";
  path: string;
  escaped: boolean;
  offset: number;
}

interface BlockNode {
  kind: "if" | "each";
  path: string;
  body: Node[];
  alternate: Node[];
  offset: number;
}

interface Frame {
  value: unknown;
  index: number;
}

interface Context {
  root: unknown;
  frames: Frame[];
}

const MISSING = Symbol("missing");

class Parser {
  private position = 0;

  constructor(private readonly source: string) {}

  parse(): Node[] {
    const result = this.parseSequence(undefined);
    if (result.stop) {
      throw this.error(`Unexpected {{${result.stop}}}`, result.stopOffset);
    }
    return result.nodes;
  }

  private parseSequence(expected: BlockNode["kind"] | undefined): {
    nodes: Node[];
    stop?: "else" | "/if" | "/each";
    stopOffset: number;
  } {
    const nodes: Node[] = [];

    while (this.position < this.source.length) {
      const start = this.source.indexOf("{{", this.position);
      if (start === -1) {
        nodes.push({ kind: "text", value: this.source.slice(this.position) });
        this.position = this.source.length;
        break;
      }
      if (start > this.position) {
        nodes.push({ kind: "text", value: this.source.slice(this.position, start) });
      }

      if (this.source.startsWith("{{{", start)) {
        const end = this.source.indexOf("}}}", start + 3);
        if (end === -1) throw this.error("Unclosed triple interpolation", start);
        const path = this.source.slice(start + 3, end).trim();
        if (!path) throw this.error("Interpolation path cannot be empty", start);
        nodes.push({ kind: "value", path, escaped: false, offset: start });
        this.position = end + 3;
        continue;
      }

      const end = this.source.indexOf("}}", start + 2);
      if (end === -1) throw this.error("Unclosed tag", start);
      const tag = this.source.slice(start + 2, end).trim();
      this.position = end + 2;

      if (tag.startsWith("!")) continue;
      if (tag === "else") {
        if (!expected) throw this.error("{{else}} is outside a block", start);
        return { nodes, stop: "else", stopOffset: start };
      }
      if (tag === "/if" || tag === "/each") {
        if (!expected) throw this.error(`Unexpected closing tag {{${tag}}}`, start);
        return { nodes, stop: tag, stopOffset: start };
      }
      if (tag.startsWith("/")) {
        throw this.error(`Unknown closing block {{${tag}}}`, start);
      }
      if (tag.startsWith("#")) {
        const match = /^#(if|each)(?:\s+(.+))$/.exec(tag);
        if (!match) {
          const name = tag.slice(1).split(/\s/, 1)[0] || "(empty)";
          throw this.error(`Unknown or invalid block '${name}'`, start);
        }
        const kind = match[1] as BlockNode["kind"];
        const path = match[2].trim();
        if (!path) throw this.error(`${kind} path cannot be empty`, start);
        nodes.push(this.parseBlock(kind, path, start));
        continue;
      }
      if (!tag) throw this.error("Interpolation path cannot be empty", start);
      nodes.push({ kind: "value", path: tag, escaped: true, offset: start });
    }

    if (expected) {
      throw this.error(`Unclosed {{#${expected}}} block`, this.source.length);
    }
    return { nodes, stopOffset: this.source.length };
  }

  private parseBlock(kind: BlockNode["kind"], path: string, offset: number): BlockNode {
    const first = this.parseSequence(kind);
    if (!first.stop) throw this.error(`Unclosed {{#${kind}}} block`, offset);

    const wantedClose = `/${kind}`;
    if (first.stop !== "else") {
      if (first.stop !== wantedClose) {
        throw this.error(
          `Mismatched closing tag: expected {{${wantedClose}}}, found {{${first.stop}}}`,
          first.stopOffset,
        );
      }
      return { kind, path, body: first.nodes, alternate: [], offset };
    }

    const second = this.parseSequence(kind);
    if (!second.stop) throw this.error(`Unclosed {{#${kind}}} block`, offset);
    if (second.stop === "else") throw this.error("Duplicate {{else}} in block", second.stopOffset);
    if (second.stop !== wantedClose) {
      throw this.error(
        `Mismatched closing tag: expected {{${wantedClose}}}, found {{${second.stop}}}`,
        second.stopOffset,
      );
    }
    return { kind, path, body: first.nodes, alternate: second.nodes, offset };
  }

  error(message: string, offset: number): Error {
    const before = this.source.slice(0, offset);
    const line = before.split("\n").length;
    const lastNewline = before.lastIndexOf("\n");
    const column = offset - lastNewline;
    return new Error(`${message} at line ${line}, column ${column}`);
  }
}

function own(object: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function descend(base: unknown, parts: string[]): unknown | typeof MISSING {
  let value = base;
  for (const part of parts) {
    if ((typeof value !== "object" || value === null) && typeof value !== "function") {
      return MISSING;
    }
    if (!own(value, part)) return MISSING;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

function resolve(path: string, context: Context): unknown | typeof MISSING {
  const frame = context.frames.at(-1);
  if (path === "this") return frame ? frame.value : context.root;
  if (path === "@index") return frame ? frame.index : MISSING;

  const parts = path.split(".");
  if (parts.some((part) => part.length === 0)) return MISSING;
  if (parts[0] === "this") {
    return frame ? descend(frame.value, parts.slice(1)) : descend(context.root, parts.slice(1));
  }
  if (parts[0] === "@index") {
    return parts.length === 1 && frame ? frame.index : MISSING;
  }

  if (frame) {
    const local = descend(frame.value, parts);
    if (local !== MISSING) return local;
  }
  return descend(context.root, parts);
}

function truthy(value: unknown | typeof MISSING): boolean {
  if (value === MISSING || value === undefined || value === null || value === false) return false;
  if (value === 0 || value === "") return false;
  if (Array.isArray(value) && value.length === 0) return false;
  return true;
}

function scalar(value: unknown | typeof MISSING, path: string, parser: Parser, offset: number): string {
  if (value === MISSING || value === undefined || value === null) return "";
  const type = typeof value;
  if (type === "object" || type === "function") {
    throw parser.error(`Cannot render non-scalar value at '${path}'`, offset);
  }
  return String(value);
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

function renderNodes(nodes: Node[], context: Context, parser: Parser): string {
  let output = "";
  for (const node of nodes) {
    if (node.kind === "text") {
      output += node.value;
    } else if (node.kind === "value") {
      const value = scalar(resolve(node.path, context), node.path, parser, node.offset);
      output += node.escaped ? escapeHtml(value) : value;
    } else if (node.kind === "if") {
      const branch = truthy(resolve(node.path, context)) ? node.body : node.alternate;
      output += renderNodes(branch, context, parser);
    } else {
      const value = resolve(node.path, context);
      if (Array.isArray(value) && value.length > 0) {
        for (let index = 0; index < value.length; index++) {
          output += renderNodes(node.body, {
            root: context.root,
            frames: [...context.frames, { value: value[index], index }],
          }, parser);
        }
      } else {
        output += renderNodes(node.alternate, context, parser);
      }
    }
  }
  return output;
}

/** Render a Mini Template string with the supplied data. */
export function render(template: string, data: unknown): string {
  const parser = new Parser(template);
  const nodes = parser.parse();
  return renderNodes(nodes, { root: data, frames: [] }, parser);
}
