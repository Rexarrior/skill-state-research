type Location = {
  index: number;
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
  parent: Node[];
  inAlternate: boolean;
};

type EachContext = {
  value: unknown;
  index: number;
};

class TemplateError extends Error {
  constructor(message: string, location: Location) {
    super(`${message} at line ${location.line}, column ${location.column}`);
    this.name = "TemplateError";
  }
}

function lineStartsFor(template: string): number[] {
  const starts = [0];
  for (let index = 0; index < template.length; index += 1) {
    if (template.charCodeAt(index) === 10) {
      starts.push(index + 1);
    }
  }
  return starts;
}

function locationAt(lineStarts: number[], index: number): Location {
  let low = 0;
  let high = lineStarts.length;

  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (lineStarts[middle] <= index) {
      low = middle;
    } else {
      high = middle;
    }
  }

  return { index, line: low + 1, column: index - lineStarts[low] + 1 };
}

function parse(template: string): Node[] {
  const lineStarts = lineStartsFor(template);
  const root: Node[] = [];
  const stack: Frame[] = [];
  let output = root;
  let cursor = 0;

  const appendText = (end: number): void => {
    if (end > cursor) {
      output.push({ kind: "text", value: template.slice(cursor, end) });
    }
  };

  while (cursor < template.length) {
    const opening = template.indexOf("{{", cursor);
    if (opening === -1) {
      output.push({ kind: "text", value: template.slice(cursor) });
      break;
    }

    appendText(opening);
    const triple = template.startsWith("{{{", opening);
    const closingText = triple ? "}}}" : "}}";
    const contentStart = opening + (triple ? 3 : 2);
    const closing = template.indexOf(closingText, contentStart);
    const location = locationAt(lineStarts, opening);

    if (closing === -1) {
      throw new TemplateError("Unclosed tag", location);
    }

    const content = template.slice(contentStart, closing).trim();
    cursor = closing + closingText.length;

    if (triple) {
      output.push({ kind: "value", path: content, escaped: false, location });
      continue;
    }

    if (content.startsWith("!")) {
      continue;
    }

    if (content === "else") {
      const frame = stack.at(-1);
      if (frame === undefined) {
        throw new TemplateError("'else' outside a block", location);
      }
      if (frame.inAlternate) {
        throw new TemplateError("Duplicate 'else'", location);
      }
      frame.inAlternate = true;
      output = frame.block.alternate;
      continue;
    }

    if (content.startsWith("#")) {
      const match = /^#(if|each)(?:\s+(.+))$/.exec(content);
      if (match === null) {
        const name = content.slice(1).trim().split(/\s+/, 1)[0] || content;
        throw new TemplateError(`Unknown or invalid block '${name}'`, location);
      }

      const block: BlockNode = {
        kind: match[1] as "if" | "each",
        path: match[2].trim(),
        body: [],
        alternate: [],
        location,
      };
      output.push(block);
      stack.push({ block, parent: output, inAlternate: false });
      output = block.body;
      continue;
    }

    if (content.startsWith("/")) {
      const name = content.slice(1).trim();
      const frame = stack.at(-1);
      if (frame === undefined) {
        throw new TemplateError(`Unexpected closing block '/${name}'`, location);
      }
      if (name !== frame.block.kind) {
        throw new TemplateError(
          `Mismatched closing block: expected '/${frame.block.kind}', got '/${name}'`,
          location,
        );
      }
      stack.pop();
      output = frame.parent;
      continue;
    }

    output.push({ kind: "value", path: content, escaped: true, location });
  }

  const unclosed = stack.at(-1);
  if (unclosed !== undefined) {
    throw new TemplateError(`Unclosed '${unclosed.block.kind}' block`, unclosed.block.location);
  }

  return root;
}

function lookup(value: unknown, parts: string[]): { found: boolean; value: unknown } {
  let current = value;

  for (const part of parts) {
    if ((typeof current !== "object" || current === null) && typeof current !== "function") {
      return { found: false, value: undefined };
    }

    const object = current as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(object, part)) {
      return { found: false, value: undefined };
    }
    current = object[part];
  }

  return { found: true, value: current };
}

function resolve(path: string, root: unknown, contexts: EachContext[]): unknown {
  if (path === "this") {
    return contexts.at(-1)?.value;
  }
  if (path.startsWith("this.")) {
    return lookup(contexts.at(-1)?.value, path.slice(5).split(".")).value;
  }
  if (path === "@index") {
    return contexts.at(-1)?.index;
  }

  const parts = path.split(".");
  const currentResult = lookup(contexts.at(-1)?.value, parts);
  if (currentResult.found) {
    return currentResult.value;
  }
  return lookup(root, parts).value;
}

function isTruthy(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (value === null || value === undefined || value === false || value === "") {
    return false;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "bigint") {
    return value !== 0n;
  }
  return true;
}

function scalarText(value: unknown, node: ValueNode): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (
    typeof value === "object" ||
    typeof value === "function" ||
    typeof value === "symbol"
  ) {
    throw new TemplateError(`Value '${node.path}' is not scalar text`, node.location);
  }
  return String(value);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function renderNodes(nodes: Node[], root: unknown, contexts: EachContext[]): string {
  let result = "";

  for (const node of nodes) {
    if (node.kind === "text") {
      result += node.value;
      continue;
    }

    if (node.kind === "value") {
      const text = scalarText(resolve(node.path, root, contexts), node);
      result += node.escaped ? escapeHtml(text) : text;
      continue;
    }

    const value = resolve(node.path, root, contexts);
    if (node.kind === "if") {
      result += renderNodes(isTruthy(value) ? node.body : node.alternate, root, contexts);
      continue;
    }

    if (!Array.isArray(value) || value.length === 0) {
      result += renderNodes(node.alternate, root, contexts);
      continue;
    }

    for (let index = 0; index < value.length; index += 1) {
      contexts.push({ value: value[index], index });
      try {
        result += renderNodes(node.body, root, contexts);
      } finally {
        contexts.pop();
      }
    }
  }

  return result;
}

/** Render a Mini Template string with the supplied root data value. */
export function render(template: string, data: unknown): string {
  return renderNodes(parse(template), data, []);
}
