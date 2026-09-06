type Location = {
  line: number;
  column: number;
};

type TextNode = {
  type: "text";
  value: string;
};

type InterpolationNode = {
  type: "interpolation";
  path: string;
  escaped: boolean;
  location: Location;
};

type BlockNode = {
  type: "if" | "each";
  path: string;
  body: Node[];
  alternate: Node[];
  location: Location;
};

type Node = TextNode | InterpolationNode | BlockNode;

type Frame = {
  block: BlockNode;
  parent: Node[];
  inElse: boolean;
};

type RenderContext = {
  root: unknown;
  current: unknown;
  index: number | undefined;
  inEach: boolean;
};

export class TemplateError extends Error {
  readonly line: number;
  readonly column: number;

  constructor(message: string, location: Location) {
    super(`${message} at line ${location.line}, column ${location.column}`);
    this.name = "TemplateError";
    this.line = location.line;
    this.column = location.column;
  }
}

function locationAt(template: string, offset: number): Location {
  let line = 1;
  let column = 1;

  for (let index = 0; index < offset; index += 1) {
    if (template.charCodeAt(index) === 10) {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }

  return { line, column };
}

function parse(template: string): Node[] {
  const root: Node[] = [];
  const stack: Frame[] = [];
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

    const location = locationAt(template, open);
    const triple = template.startsWith("{{{", open);
    const closeToken = triple ? "}}}" : "}}";
    const contentStart = open + (triple ? 3 : 2);
    const close = template.indexOf(closeToken, contentStart);

    if (close === -1) {
      throw new TemplateError("Unclosed tag", location);
    }

    const content = template.slice(contentStart, close).trim();
    cursor = close + closeToken.length;

    if (triple) {
      if (!content) {
        throw new TemplateError("Empty interpolation", location);
      }
      output.push({ type: "interpolation", path: content, escaped: false, location });
      continue;
    }

    if (content.startsWith("!")) {
      continue;
    }

    if (content.startsWith("#")) {
      const match = /^#(if|each)(?:\s+(.+))$/.exec(content);
      if (!match) {
        const name = content.slice(1).trim().split(/\s+/, 1)[0] || "(empty)";
        throw new TemplateError(`Unknown or invalid block '${name}'`, location);
      }

      const block: BlockNode = {
        type: match[1] as "if" | "each",
        path: match[2].trim(),
        body: [],
        alternate: [],
        location,
      };
      output.push(block);
      stack.push({ block, parent: output, inElse: false });
      output = block.body;
      continue;
    }

    if (content === "else") {
      const frame = stack.at(-1);
      if (!frame) {
        throw new TemplateError("'else' outside a block", location);
      }
      if (frame.inElse) {
        throw new TemplateError("Duplicate 'else'", location);
      }
      frame.inElse = true;
      output = frame.block.alternate;
      continue;
    }

    if (content.startsWith("/")) {
      const name = content.slice(1).trim();
      const frame = stack.at(-1);
      if (!frame) {
        throw new TemplateError(`Closing '${name}' without an open block`, location);
      }
      if (name !== frame.block.type) {
        throw new TemplateError(
          `Mismatched closing block '${name}'; expected '${frame.block.type}'`,
          location,
        );
      }
      stack.pop();
      output = frame.parent;
      continue;
    }

    if (!content) {
      throw new TemplateError("Empty interpolation", location);
    }
    output.push({ type: "interpolation", path: content, escaped: true, location });
  }

  const unclosed = stack.at(-1)?.block;
  if (unclosed) {
    throw new TemplateError(`Unclosed '${unclosed.type}' block`, unclosed.location);
  }

  return root;
}

function ownValue(value: unknown, parts: string[]): { found: boolean; value: unknown } {
  let current = value;

  for (const part of parts) {
    if ((typeof current !== "object" || current === null) && typeof current !== "function") {
      return { found: false, value: undefined };
    }
    if (!Object.prototype.hasOwnProperty.call(current, part)) {
      return { found: false, value: undefined };
    }
    current = (current as Record<string, unknown>)[part];
  }

  return { found: true, value: current };
}

function resolve(path: string, context: RenderContext): unknown {
  if (path === "this") {
    return context.inEach ? context.current : context.root;
  }
  if (path === "@index") {
    return context.inEach ? context.index : undefined;
  }

  if (path.startsWith("this.")) {
    return ownValue(context.current, path.slice(5).split(".")).value;
  }

  const parts = path.split(".");
  if (context.inEach) {
    const local = ownValue(context.current, parts);
    if (local.found) {
      return local.value;
    }
  }
  return ownValue(context.root, parts).value;
}

function isTruthy(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  return !(
    value === ""
    || value === 0
    || value === 0n
    || value === false
    || value === null
    || value === undefined
  );
}

function scalarText(value: unknown, path: string, location: Location): string {
  if (value === null || value === undefined) {
    return "";
  }

  switch (typeof value) {
    case "string":
    case "number":
    case "boolean":
    case "bigint":
      return String(value);
    default:
      throw new TemplateError(`Value at '${path}' is not a renderable scalar`, location);
  }
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

function renderNodes(nodes: Node[], context: RenderContext): string {
  let result = "";

  for (const node of nodes) {
    if (node.type === "text") {
      result += node.value;
      continue;
    }

    if (node.type === "interpolation") {
      const text = scalarText(resolve(node.path, context), node.path, node.location);
      result += node.escaped ? escapeHtml(text) : text;
      continue;
    }

    const value = resolve(node.path, context);
    if (node.type === "if") {
      result += renderNodes(isTruthy(value) ? node.body : node.alternate, context);
      continue;
    }

    if (!Array.isArray(value)) {
      result += renderNodes(node.alternate, context);
      continue;
    }
    if (value.length === 0) {
      result += renderNodes(node.alternate, context);
      continue;
    }

    for (let index = 0; index < value.length; index += 1) {
      result += renderNodes(node.body, {
        root: context.root,
        current: value[index],
        index,
        inEach: true,
      });
    }
  }

  return result;
}

/** Render a Mini Template string with the supplied data. */
export function render(template: string, data: unknown): string {
  return renderNodes(parse(template), {
    root: data,
    current: data,
    index: undefined,
    inEach: false,
  });
}
