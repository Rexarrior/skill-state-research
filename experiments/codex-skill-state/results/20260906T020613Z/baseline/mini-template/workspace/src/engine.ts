type Location = {
  line: number;
  column: number;
};

type TextNode = {
  kind: "text";
  value: string;
};

type ValueNode = {
  kind: "value";
  path: string;
  escaped: boolean;
  location: Location;
};

type BlockNode = {
  kind: "if" | "each";
  path: string;
  body: Node[];
  alternate: Node[];
  location: Location;
};

type Node = TextNode | ValueNode | BlockNode;

type Frame = {
  block: BlockNode;
  output: Node[];
  hasElse: boolean;
};

type IterationContext = {
  value: unknown;
  index: number;
};

const PATH_PATTERN = /^(?:this|@index|[^.\s{}\/]+)(?:\.[^.\s{}\/]+)*$/;

function syntaxError(message: string, location: Location): Error {
  return new Error(`${message} at line ${location.line}, column ${location.column}`);
}

function locationAt(source: string, offset: number): Location {
  let line = 1;
  let column = 1;

  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }

  return { line, column };
}

function validatePath(path: string, location: Location): void {
  if (!PATH_PATTERN.test(path)) {
    throw syntaxError(path ? `Invalid path \"${path}\"` : "Expected a path", location);
  }
}

function parse(template: string): Node[] {
  const root: Node[] = [];
  const stack: Frame[] = [];
  let output = root;
  let cursor = 0;

  while (cursor < template.length) {
    const opening = template.indexOf("{{", cursor);
    if (opening === -1) {
      output.push({ kind: "text", value: template.slice(cursor) });
      break;
    }

    if (opening > cursor) {
      output.push({ kind: "text", value: template.slice(cursor, opening) });
    }

    const triple = template.startsWith("{{{", opening);
    const terminator = triple ? "}}}" : "}}";
    const contentStart = opening + (triple ? 3 : 2);
    const closing = template.indexOf(terminator, contentStart);
    const location = locationAt(template, opening);

    if (closing === -1) {
      throw syntaxError("Unclosed tag", location);
    }

    const content = template.slice(contentStart, closing).trim();
    cursor = closing + terminator.length;

    if (triple) {
      validatePath(content, location);
      output.push({ kind: "value", path: content, escaped: false, location });
      continue;
    }

    if (content.startsWith("!")) {
      continue;
    }

    if (content === "else") {
      const frame = stack.at(-1);
      if (!frame) {
        throw syntaxError("Unexpected else outside a block", location);
      }
      if (frame.hasElse) {
        throw syntaxError(`Duplicate else in ${frame.block.kind} block`, location);
      }
      frame.hasElse = true;
      frame.output = frame.block.alternate;
      output = frame.output;
      continue;
    }

    if (content.startsWith("#")) {
      const match = /^#(\S+)(?:\s+(.+?))?$/.exec(content);
      const blockKind = match?.[1];
      const path = match?.[2]?.trim() ?? "";

      if (blockKind !== "if" && blockKind !== "each") {
        throw syntaxError(`Unknown block \"${blockKind ?? content.slice(1)}\"`, location);
      }
      validatePath(path, location);

      const block: BlockNode = {
        kind: blockKind,
        path,
        body: [],
        alternate: [],
        location,
      };
      output.push(block);
      const frame: Frame = { block, output: block.body, hasElse: false };
      stack.push(frame);
      output = frame.output;
      continue;
    }

    if (content.startsWith("/")) {
      const closingKind = content.slice(1).trim();
      const frame = stack.at(-1);

      if (!frame) {
        throw syntaxError(`Unexpected closing block \"${closingKind}\"`, location);
      }
      if (closingKind !== frame.block.kind) {
        throw syntaxError(
          `Mismatched closing block: expected /${frame.block.kind}, received /${closingKind}`,
          location,
        );
      }

      stack.pop();
      output = stack.at(-1)?.output ?? root;
      continue;
    }

    validatePath(content, location);
    output.push({ kind: "value", path: content, escaped: true, location });
  }

  const frame = stack.at(-1);
  if (frame) {
    throw syntaxError(`Unclosed ${frame.block.kind} block`, frame.block.location);
  }

  return root;
}

function ownValue(value: unknown, segments: string[]): { found: boolean; value: unknown } {
  let current = value;

  for (const segment of segments) {
    if ((typeof current !== "object" || current === null) && typeof current !== "function") {
      return { found: false, value: undefined };
    }
    if (!Object.prototype.hasOwnProperty.call(current, segment)) {
      return { found: false, value: undefined };
    }
    current = (current as Record<string, unknown>)[segment];
  }

  return { found: true, value: current };
}

function resolve(path: string, root: unknown, contexts: IterationContext[]): unknown {
  const segments = path.split(".");

  if (segments[0] === "this") {
    const current = contexts.at(-1)?.value;
    return segments.length === 1 ? current : ownValue(current, segments.slice(1)).value;
  }
  if (segments[0] === "@index") {
    return segments.length === 1 ? contexts.at(-1)?.index : undefined;
  }

  for (let index = contexts.length - 1; index >= 0; index -= 1) {
    const result = ownValue(contexts[index]!.value, segments);
    if (result.found) return result.value;
  }

  return ownValue(root, segments).value;
}

function isTruthy(value: unknown): boolean {
  if (value === "" || value === 0 || value === false || value === null || value === undefined) {
    return false;
  }
  return !Array.isArray(value) || value.length > 0;
}

function scalarText(value: unknown, path: string, location: Location): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }

  throw syntaxError(`Value at \"${path}\" cannot be rendered as scalar text`, location);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case "\"": return "&quot;";
      default: return "&#39;";
    }
  });
}

function renderNodes(nodes: Node[], root: unknown, contexts: IterationContext[]): string {
  let result = "";

  for (const node of nodes) {
    if (node.kind === "text") {
      result += node.value;
      continue;
    }

    const value = resolve(node.path, root, contexts);

    if (node.kind === "value") {
      const text = scalarText(value, node.path, node.location);
      result += node.escaped ? escapeHtml(text) : text;
      continue;
    }

    if (node.kind === "if") {
      result += renderNodes(isTruthy(value) ? node.body : node.alternate, root, contexts);
      continue;
    }

    if (Array.isArray(value) && value.length > 0) {
      for (let index = 0; index < value.length; index += 1) {
        contexts.push({ value: value[index], index });
        try {
          result += renderNodes(node.body, root, contexts);
        } finally {
          contexts.pop();
        }
      }
    } else {
      result += renderNodes(node.alternate, root, contexts);
    }
  }

  return result;
}

/** Render a Mini Template string using the supplied data. */
export function render(template: string, data: unknown): string {
  return renderNodes(parse(template), data, []);
}
