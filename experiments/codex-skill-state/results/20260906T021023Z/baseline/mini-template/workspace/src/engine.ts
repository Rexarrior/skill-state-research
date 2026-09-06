export class TemplateError extends Error {
  readonly line: number;
  readonly column: number;

  constructor(message: string, line: number, column: number) {
    super(`Template error at line ${line}, column ${column}: ${message}`);
    this.name = "TemplateError";
    this.line = line;
    this.column = column;
  }
}

type Location = { line: number; column: number };

type Node =
  | { kind: "text"; value: string }
  | { kind: "value"; path: string; escaped: boolean; location: Location }
  | BlockNode;

type BlockNode = {
  kind: "if" | "each";
  path: string;
  truthy: Node[];
  falsy: Node[];
  location: Location;
};

type Frame = {
  block: BlockNode;
  parent: Node[];
  hasElse: boolean;
};

const PATH_PATTERN = /^(?:@index|[^.\s{}]+(?:\.[^.\s{}]+)*)$/;
const MISSING = Symbol("missing");

function makeLocator(source: string): (offset: number) => Location {
  const lineStarts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source.charCodeAt(index) === 10) {
      lineStarts.push(index + 1);
    }
  }

  return (offset: number): Location => {
    let low = 0;
    let high = lineStarts.length;
    while (low + 1 < high) {
      const middle = Math.floor((low + high) / 2);
      if (lineStarts[middle] <= offset) {
        low = middle;
      } else {
        high = middle;
      }
    }
    return { line: low + 1, column: offset - lineStarts[low] + 1 };
  };
}

function fail(message: string, location: Location): never {
  throw new TemplateError(message, location.line, location.column);
}

function checkPath(path: string, location: Location): string {
  if (!PATH_PATTERN.test(path)) {
    fail(path.length === 0 ? "expected a path" : `invalid path \"${path}\"`, location);
  }
  return path;
}

function parse(template: string): Node[] {
  const root: Node[] = [];
  const stack: Frame[] = [];
  const locate = makeLocator(template);
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
    const location = locate(opening);

    if (closing === -1) {
      fail(`unclosed ${triple ? "triple interpolation" : "tag"}`, location);
    }

    const content = template.slice(contentStart, closing).trim();
    cursor = closing + terminator.length;

    if (triple) {
      output.push({
        kind: "value",
        path: checkPath(content, location),
        escaped: false,
        location,
      });
      continue;
    }

    if (content.startsWith("!")) {
      continue;
    }

    const openBlock = /^#([^\s]+)(?:\s+(.*))?$/.exec(content);
    if (openBlock) {
      const blockKind = openBlock[1];
      if (blockKind !== "if" && blockKind !== "each") {
        fail(`unknown block \"${blockKind}\"`, location);
      }

      const block: BlockNode = {
        kind: blockKind,
        path: checkPath((openBlock[2] ?? "").trim(), location),
        truthy: [],
        falsy: [],
        location,
      };
      output.push(block);
      stack.push({ block, parent: output, hasElse: false });
      output = block.truthy;
      continue;
    }

    if (content.startsWith("#")) {
      fail("malformed block opening", location);
    }

    if (content === "else") {
      const frame = stack.at(-1);
      if (!frame) {
        fail("else outside a block", location);
      }
      if (frame.hasElse) {
        fail(`duplicate else in ${frame.block.kind} block`, location);
      }
      frame.hasElse = true;
      output = frame.block.falsy;
      continue;
    }

    if (content.startsWith("else ")) {
      fail("else tag must not contain an expression", location);
    }

    const closeBlock = /^\/([^\s]+)(?:\s+.*)?$/.exec(content);
    if (closeBlock) {
      const blockKind = closeBlock[1];
      if (blockKind !== "if" && blockKind !== "each") {
        fail(`unknown closing block \"${blockKind}\"`, location);
      }
      if (content !== `/${blockKind}`) {
        fail(`closing ${blockKind} tag must not contain an expression`, location);
      }

      const frame = stack.at(-1);
      if (!frame) {
        fail(`closing ${blockKind} without an open block`, location);
      }
      if (frame.block.kind !== blockKind) {
        fail(`mismatched closing block: expected /${frame.block.kind}, found /${blockKind}`, location);
      }

      stack.pop();
      output = frame.parent;
      continue;
    }

    if (content.startsWith("/")) {
      fail("malformed closing block", location);
    }

    output.push({
      kind: "value",
      path: checkPath(content, location),
      escaped: true,
      location,
    });
  }

  const unclosed = stack.at(-1);
  if (unclosed) {
    fail(`unclosed ${unclosed.block.kind} block`, unclosed.block.location);
  }

  return root;
}

function lookup(value: unknown, segments: string[]): unknown | typeof MISSING {
  let current = value;

  for (const segment of segments) {
    if ((typeof current !== "object" || current === null) && typeof current !== "function") {
      return MISSING;
    }
    if (!Object.prototype.hasOwnProperty.call(current, segment)) {
      return MISSING;
    }
    current = (current as Record<string, unknown>)[segment];
  }

  return current;
}

type RenderContext = {
  root: unknown;
  current: unknown;
  index: number | undefined;
};

function resolve(path: string, context: RenderContext): unknown | typeof MISSING {
  if (path === "this") {
    return context.current;
  }
  if (path === "@index") {
    return context.index === undefined ? MISSING : context.index;
  }

  if (path.startsWith("this.")) {
    return lookup(context.current, path.slice(5).split("."));
  }

  const segments = path.split(".");
  const local = lookup(context.current, segments);
  if (local !== MISSING) {
    return local;
  }
  return context.current === context.root ? MISSING : lookup(context.root, segments);
}

function isTruthy(value: unknown | typeof MISSING): boolean {
  if (value === MISSING || value === null || value === undefined || value === false || value === 0 || value === 0n || value === "") {
    return false;
  }
  return !Array.isArray(value) || value.length > 0;
}

function scalarText(value: unknown | typeof MISSING, path: string, location: Location): string {
  if (value === MISSING || value === null || value === undefined) {
    return "";
  }

  switch (typeof value) {
    case "string":
      return value;
    case "number":
    case "boolean":
    case "bigint":
    case "symbol":
      return String(value);
    default:
      fail(`cannot render \"${path}\" as scalar text (received ${typeof value})`, location);
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
    if (node.kind === "text") {
      result += node.value;
      continue;
    }

    if (node.kind === "value") {
      const text = scalarText(resolve(node.path, context), node.path, node.location);
      result += node.escaped ? escapeHtml(text) : text;
      continue;
    }

    const value = resolve(node.path, context);
    if (node.kind === "if") {
      result += renderNodes(isTruthy(value) ? node.truthy : node.falsy, context);
      continue;
    }

    if (!Array.isArray(value) || value.length === 0) {
      result += renderNodes(node.falsy, context);
      continue;
    }

    for (let index = 0; index < value.length; index += 1) {
      result += renderNodes(node.truthy, {
        root: context.root,
        current: value[index],
        index,
      });
    }
  }

  return result;
}

/** Render a Mini Template string with values from data. */
export function render(template: string, data: unknown): string {
  const nodes = parse(template);
  return renderNodes(nodes, { root: data, current: data, index: undefined });
}
