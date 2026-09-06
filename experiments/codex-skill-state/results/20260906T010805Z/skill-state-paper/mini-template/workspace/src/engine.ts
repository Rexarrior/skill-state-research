type Position = {
  offset: number;
  line: number;
  column: number;
};

type TextNode = { type: "text"; value: string };
type InterpolationNode = {
  type: "interpolation";
  path: string;
  escaped: boolean;
  position: Position;
};
type BlockNode = {
  type: "if" | "each";
  path: string;
  truthy: Node[];
  falsy: Node[];
  position: Position;
};
type Node = TextNode | InterpolationNode | BlockNode;

type Stop =
  | { kind: "eof" }
  | { kind: "else"; position: Position }
  | { kind: "close"; name: string; position: Position };

type Frame = { value: unknown; index: number };
type Context = { root: unknown; frames: Frame[] };

const pathPattern = /^(?:this|@index|[A-Za-z_$][\w$]*)(?:\.[A-Za-z_$][\w$]*)*$/;

class Parser {
  private offset = 0;

  constructor(private readonly source: string) {}

  parse(): Node[] {
    const result = this.parseSequence(undefined, false);
    if (result.stop.kind === "close") {
      this.fail(`Unexpected closing block "${result.stop.name}"`, result.stop.position);
    }
    if (result.stop.kind === "else") {
      this.fail("{{else}} used outside a block", result.stop.position);
    }
    return result.nodes;
  }

  private parseSequence(expected: "if" | "each" | undefined, afterElse: boolean): { nodes: Node[]; stop: Stop } {
    const nodes: Node[] = [];

    while (this.offset < this.source.length) {
      const open = this.source.indexOf("{{", this.offset);
      if (open === -1) {
        nodes.push({ type: "text", value: this.source.slice(this.offset) });
        this.offset = this.source.length;
        return { nodes, stop: { kind: "eof" } };
      }

      if (open > this.offset) nodes.push({ type: "text", value: this.source.slice(this.offset, open) });
      const position = this.positionAt(open);

      if (this.source.startsWith("{{{", open)) {
        const close = this.source.indexOf("}}}", open + 3);
        if (close === -1) this.fail("Unclosed triple interpolation", position);
        const path = this.source.slice(open + 3, close).trim();
        this.validatePath(path, position);
        nodes.push({ type: "interpolation", path, escaped: false, position });
        this.offset = close + 3;
        continue;
      }

      const close = this.source.indexOf("}}", open + 2);
      if (close === -1) this.fail("Unclosed tag", position);
      const content = this.source.slice(open + 2, close).trim();
      this.offset = close + 2;

      if (content.startsWith("!")) continue;

      if (content === "else") {
        if (!expected) this.fail("{{else}} used outside a block", position);
        if (afterElse) this.fail("Duplicate {{else}}", position);
        return { nodes, stop: { kind: "else", position } };
      }

      if (content.startsWith("/")) {
        const name = content.slice(1).trim();
        if (name !== "if" && name !== "each") this.fail(`Unknown closing block "${name}"`, position);
        return { nodes, stop: { kind: "close", name, position } };
      }

      if (content.startsWith("#")) {
        const match = /^#(if|each)\s+(.+)$/.exec(content);
        if (!match) {
          const name = content.slice(1).split(/\s/, 1)[0] || content;
          this.fail(`Unknown or malformed block "${name}"`, position);
        }
        const kind = match[1] as "if" | "each";
        const path = match[2].trim();
        this.validatePath(path, position);

        const first = this.parseSequence(kind, false);
        let falsy: Node[] = [];
        let stop = first.stop;
        if (stop.kind === "else") {
          const second = this.parseSequence(kind, true);
          falsy = second.nodes;
          stop = second.stop;
        }
        if (stop.kind === "eof") this.fail(`Unclosed {{#${kind}}} block`, position);
        if (stop.kind !== "close" || stop.name !== kind) {
          const actual = stop.kind === "close" ? stop.name : "else";
          this.fail(`Mismatched closing block: expected "/${kind}", found "${actual}"`, stop.position);
        }
        nodes.push({ type: kind, path, truthy: first.nodes, falsy, position });
        continue;
      }

      this.validatePath(content, position);
      nodes.push({ type: "interpolation", path: content, escaped: true, position });
    }

    return { nodes, stop: { kind: "eof" } };
  }

  private validatePath(path: string, position: Position): void {
    if (!path || !pathPattern.test(path)) this.fail(`Invalid path "${path}"`, position);
  }

  private positionAt(offset: number): Position {
    let line = 1;
    let column = 1;
    for (let i = 0; i < offset; i++) {
      if (this.source.charCodeAt(i) === 10) {
        line++;
        column = 1;
      } else {
        column++;
      }
    }
    return { offset, line, column };
  }

  private fail(message: string, position: Position): never {
    throw new TemplateError(message, position.line, position.column);
  }
}

export class TemplateError extends Error {
  constructor(message: string, public readonly line: number, public readonly column: number) {
    super(`${message} at line ${line}, column ${column}`);
    this.name = "TemplateError";
  }
}

function hasProperty(value: unknown, key: string): boolean {
  return (typeof value === "object" && value !== null) || typeof value === "function"
    ? key in value
    : false;
}

function getProperty(value: unknown, key: string): unknown {
  if (!hasProperty(value, key)) return undefined;
  return (value as Record<string, unknown>)[key];
}

function follow(value: unknown, parts: string[]): unknown {
  for (const part of parts) value = getProperty(value, part);
  return value;
}

function resolve(path: string, context: Context): unknown {
  const parts = path.split(".");
  const frame = context.frames.at(-1);

  if (parts[0] === "this") return follow(frame?.value, parts.slice(1));
  if (parts[0] === "@index") return follow(frame?.index, parts.slice(1));

  for (let index = context.frames.length - 1; index >= 0; index--) {
    const candidate = context.frames[index]?.value;
    if (hasProperty(candidate, parts[0])) return follow(candidate, parts);
  }
  return follow(context.root, parts);
}

function isTruthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return value !== "" && value !== 0 && value !== false && value !== null && value !== undefined;
}

function scalar(value: unknown, path: string, position: Position): string {
  if (value === null || value === undefined) return "";
  switch (typeof value) {
    case "string":
    case "number":
    case "boolean":
    case "bigint":
      return String(value);
    default:
      throw new TemplateError(`Value at "${path}" is not scalar text`, position.line, position.column);
  }
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

function renderNodes(nodes: Node[], context: Context): string {
  let output = "";
  for (const node of nodes) {
    if (node.type === "text") {
      output += node.value;
    } else if (node.type === "interpolation") {
      const value = scalar(resolve(node.path, context), node.path, node.position);
      output += node.escaped ? escapeHtml(value) : value;
    } else if (node.type === "if") {
      const branch = isTruthy(resolve(node.path, context)) ? node.truthy : node.falsy;
      output += renderNodes(branch, context);
    } else {
      const value = resolve(node.path, context);
      if (Array.isArray(value) && value.length > 0) {
        for (let index = 0; index < value.length; index++) {
          output += renderNodes(node.truthy, {
            root: context.root,
            frames: [...context.frames, { value: value[index], index }],
          });
        }
      } else {
        output += renderNodes(node.falsy, context);
      }
    }
  }
  return output;
}

export function render(template: string, data: unknown): string {
  const nodes = new Parser(template).parse();
  return renderNodes(nodes, { root: data, frames: [] });
}
