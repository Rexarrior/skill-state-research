type Position = { line: number; column: number };

type Node =
  | { kind: "text"; value: string }
  | { kind: "value"; path: string; escaped: boolean; position: Position }
  | {
      kind: "block";
      block: "if" | "each";
      path: string;
      body: Node[];
      alternate: Node[];
      position: Position;
    };

type Context = { value: unknown; index?: number; parent?: Context };

class TemplateError extends Error {
  constructor(message: string, position: Position) {
    super(`${message} at line ${position.line}, column ${position.column}`);
    this.name = "TemplateError";
  }
}

class Parser {
  private offset = 0;

  constructor(private readonly source: string) {}

  parse(): Node[] {
    const result = this.parseSequence(undefined);
    if (result.stop) {
      throw new TemplateError(
        result.stop === "else" ? "Unexpected else outside a block" : `Unexpected closing block /${result.stop.slice(1)}`,
        result.position!,
      );
    }
    return result.nodes;
  }

  private parseSequence(expected: "if" | "each" | undefined): {
    nodes: Node[];
    stop?: "else" | "/if" | "/each";
    position?: Position;
  } {
    const nodes: Node[] = [];
    while (this.offset < this.source.length) {
      const start = this.source.indexOf("{{", this.offset);
      if (start === -1) {
        nodes.push({ kind: "text", value: this.source.slice(this.offset) });
        this.offset = this.source.length;
        break;
      }
      if (start > this.offset) nodes.push({ kind: "text", value: this.source.slice(this.offset, start) });

      const position = this.positionAt(start);
      const triple = this.source.startsWith("{{{", start);
      const close = this.source.indexOf(triple ? "}}}" : "}}", start + (triple ? 3 : 2));
      if (close === -1) throw new TemplateError("Unclosed tag", position);

      const raw = this.source.slice(start + (triple ? 3 : 2), close).trim();
      this.offset = close + (triple ? 3 : 2);
      if (!raw) throw new TemplateError("Empty tag", position);

      if (triple) {
        nodes.push({ kind: "value", path: raw, escaped: false, position });
        continue;
      }
      if (raw.startsWith("!")) continue;
      if (raw === "else") return { nodes, stop: "else", position };
      if (raw === "/if" || raw === "/each") return { nodes, stop: raw, position };

      if (raw.startsWith("#")) {
        const match = /^#(if|each)\s+(.+)$/.exec(raw);
        if (!match) {
          const name = raw.slice(1).trim().split(/\s/, 1)[0] || raw;
          throw new TemplateError(`Unknown or malformed block ${name}`, position);
        }
        const block = match[1] as "if" | "each";
        const path = match[2].trim();
        this.validatePath(path, position);
        const first = this.parseSequence(block);
        let alternate: Node[] = [];
        let closing = first.stop;
        let closingPosition = first.position;
        if (closing === "else") {
          const second = this.parseSequence(block);
          alternate = second.nodes;
          closing = second.stop;
          closingPosition = second.position;
          if (closing === "else") throw new TemplateError("Duplicate else", closingPosition!);
        }
        if (!closing) throw new TemplateError(`Unclosed block ${block}`, position);
        if (closing !== `/${block}`) {
          throw new TemplateError(`Mismatched closing block ${closing}; expected /${block}`, closingPosition!);
        }
        nodes.push({ kind: "block", block, path, body: first.nodes, alternate, position });
        continue;
      }
      if (raw.startsWith("/")) throw new TemplateError(`Unknown closing block ${raw}`, position);
      this.validatePath(raw, position);
      nodes.push({ kind: "value", path: raw, escaped: true, position });
    }
    return { nodes };
  }

  private validatePath(path: string, position: Position): void {
    if (path === "this" || path === "@index") return;
    if (!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(path)) {
      throw new TemplateError(`Invalid path "${path}"`, position);
    }
  }

  private positionAt(offset: number): Position {
    const before = this.source.slice(0, offset);
    const line = before.split("\n").length;
    const lastNewline = before.lastIndexOf("\n");
    return { line, column: offset - lastNewline };
  }
}

function getProperty(value: unknown, parts: string[]): unknown {
  let current = value;
  for (const part of parts) {
    if (current === null || current === undefined || (typeof current !== "object" && typeof current !== "function")) {
      return undefined;
    }
    if (!Object.prototype.hasOwnProperty.call(current, part)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function resolve(path: string, context: Context, root: unknown): unknown {
  if (path === "this") return context.value;
  if (path === "@index") return context.index;
  const parts = path.split(".");
  const local = getProperty(context.value, parts);
  return local === undefined ? getProperty(root, parts) : local;
}

function isTruthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return value !== "" && value !== 0 && value !== false && value !== null && value !== undefined;
}

function scalar(value: unknown, position: Position): string {
  if (value === null || value === undefined) return "";
  switch (typeof value) {
    case "string":
    case "number":
    case "boolean":
    case "bigint":
      return String(value);
    default:
      throw new TemplateError(`Cannot render ${typeof value === "object" ? "an object" : `a ${typeof value}`} as text`, position);
  }
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

function renderNodes(nodes: Node[], context: Context, root: unknown): string {
  let output = "";
  for (const node of nodes) {
    if (node.kind === "text") {
      output += node.value;
    } else if (node.kind === "value") {
      const value = scalar(resolve(node.path, context, root), node.position);
      output += node.escaped ? escapeHtml(value) : value;
    } else {
      const value = resolve(node.path, context, root);
      if (node.block === "if") {
        output += renderNodes(isTruthy(value) ? node.body : node.alternate, context, root);
      } else if (Array.isArray(value) && value.length > 0) {
        for (let index = 0; index < value.length; index++) {
          output += renderNodes(node.body, { value: value[index], index, parent: context }, root);
        }
      } else {
        output += renderNodes(node.alternate, context, root);
      }
    }
  }
  return output;
}

/** Render a Mini Template string with the supplied data. */
export function render(template: string, data: unknown): string {
  const nodes = new Parser(template).parse();
  return renderNodes(nodes, { value: data }, data);
}

