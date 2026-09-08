type Location = {
  line: number;
  column: number;
};

type TextNode = { type: "text"; value: string };
type ValueNode = {
  type: "value";
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
type Node = TextNode | ValueNode | BlockNode;

type OpenBlock = {
  node: BlockNode;
  parent: Node[];
  inElse: boolean;
};

type Scope = {
  root: unknown;
  current: unknown;
  index: number | undefined;
  inEach: boolean;
};

export class TemplateError extends Error {
  readonly line: number;
  readonly column: number;

  constructor(message: string, location: Location) {
    super(`${message} (line ${location.line}, column ${location.column})`);
    this.name = "TemplateError";
    this.line = location.line;
    this.column = location.column;
  }
}

function locationAt(lineStarts: number[], offset: number): Location {
  let low = 0;
  let high = lineStarts.length;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (lineStarts[middle] <= offset) low = middle;
    else high = middle;
  }
  return { line: low + 1, column: offset - lineStarts[low] + 1 };
}

function validatePath(path: string, location: Location): string {
  if (path.length === 0) {
    throw new TemplateError("Expected a path", location);
  }
  if (/\s|[{}]/u.test(path) || path.split(".").some((part) => part.length === 0)) {
    throw new TemplateError(`Invalid path \"${path}\"`, location);
  }
  if (path.startsWith("@") && path !== "@index") {
    throw new TemplateError(`Unknown local value \"${path}\"`, location);
  }
  return path;
}

function parse(template: string): Node[] {
  const lineStarts = [0];
  for (let i = 0; i < template.length; i += 1) {
    if (template.charCodeAt(i) === 10) lineStarts.push(i + 1);
  }
  const root: Node[] = [];
  const stack: OpenBlock[] = [];
  let output = root;
  let position = 0;

  while (position < template.length) {
    const opening = template.indexOf("{{", position);
    if (opening === -1) {
      output.push({ type: "text", value: template.slice(position) });
      break;
    }
    if (opening > position) {
      output.push({ type: "text", value: template.slice(position, opening) });
    }

    const triple = template.startsWith("{{{", opening);
    const closeToken = triple ? "}}}" : "}}";
    const contentStart = opening + (triple ? 3 : 2);
    const closing = template.indexOf(closeToken, contentStart);
    const location = locationAt(lineStarts, opening);
    if (closing === -1) {
      throw new TemplateError(`Unclosed ${triple ? "triple" : "template"} tag`, location);
    }

    const content = template.slice(contentStart, closing).trim();
    position = closing + closeToken.length;

    if (triple) {
      output.push({
        type: "value",
        path: validatePath(content, location),
        escaped: false,
        location,
      });
      continue;
    }

    if (content.startsWith("!")) continue;

    const openMatch = /^#([^\s]+)(?:\s+(.+))?$/u.exec(content);
    if (openMatch) {
      const kind = openMatch[1];
      if (kind !== "if" && kind !== "each") {
        throw new TemplateError(`Unknown block \"${kind}\"`, location);
      }
      const node: BlockNode = {
        type: kind,
        path: validatePath((openMatch[2] ?? "").trim(), location),
        body: [],
        alternate: [],
        location,
      };
      output.push(node);
      stack.push({ node, parent: output, inElse: false });
      output = node.body;
      continue;
    }

    if (content === "else") {
      const active = stack.at(-1);
      if (!active) throw new TemplateError("else outside a block", location);
      if (active.inElse) throw new TemplateError("Duplicate else", location);
      active.inElse = true;
      output = active.node.alternate;
      continue;
    }

    if (content.startsWith("/")) {
      const closeName = content.slice(1).trim();
      if (!closeName || /\s/u.test(closeName)) {
        throw new TemplateError(`Invalid closing tag \"${content}\"`, location);
      }
      const active = stack.at(-1);
      if (!active) {
        throw new TemplateError(`Closing \"${closeName}\" without an open block`, location);
      }
      if (active.node.type !== closeName) {
        throw new TemplateError(
          `Mismatched closing block: expected \"/${active.node.type}\" but found \"/${closeName}\"`,
          location,
        );
      }
      stack.pop();
      output = active.parent;
      continue;
    }

    if (content.startsWith("#")) {
      throw new TemplateError(`Invalid block tag \"${content}\"`, location);
    }

    output.push({
      type: "value",
      path: validatePath(content, location),
      escaped: true,
      location,
    });
  }

  const unclosed = stack.at(-1);
  if (unclosed) {
    throw new TemplateError(`Unclosed \"${unclosed.node.type}\" block`, unclosed.node.location);
  }
  return root;
}

function getPath(value: unknown, parts: string[]): { found: boolean; value: unknown } {
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

function resolve(path: string, scope: Scope): unknown {
  if (path === "@index") return scope.inEach ? scope.index : undefined;
  if (path === "this") return scope.current;
  if (path.startsWith("this.")) {
    return getPath(scope.current, path.slice(5).split(".")).value;
  }
  const parts = path.split(".");
  if (scope.inEach) {
    const local = getPath(scope.current, parts);
    if (local.found) return local.value;
  }
  return getPath(scope.root, parts).value;
}

function isTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (value === "" || value === 0 || value === 0n) return false;
  if (Array.isArray(value) && value.length === 0) return false;
  return true;
}

function scalarText(value: unknown, path: string, location: Location): string {
  if (value === null || value === undefined) return "";
  switch (typeof value) {
    case "string":
    case "number":
    case "bigint":
    case "boolean":
      return String(value);
    default:
      throw new TemplateError(`Value at \"${path}\" is not scalar text`, location);
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => {
    switch (character) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case "\"": return "&quot;";
      default: return "&#39;";
    }
  });
}

function renderNodes(nodes: Node[], scope: Scope): string {
  let result = "";
  for (const node of nodes) {
    if (node.type === "text") {
      result += node.value;
    } else if (node.type === "value") {
      const text = scalarText(resolve(node.path, scope), node.path, node.location);
      result += node.escaped ? escapeHtml(text) : text;
    } else if (node.type === "if") {
      result += renderNodes(isTruthy(resolve(node.path, scope)) ? node.body : node.alternate, scope);
    } else {
      const collection = resolve(node.path, scope);
      if (!Array.isArray(collection) || collection.length === 0) {
        result += renderNodes(node.alternate, scope);
        continue;
      }
      for (let index = 0; index < collection.length; index += 1) {
        result += renderNodes(node.body, {
          root: scope.root,
          current: collection[index],
          index,
          inEach: true,
        });
      }
    }
  }
  return result;
}

/** Render a Mini Template string using values from `data`. */
export function render(template: string, data: unknown): string {
  return renderNodes(parse(template), {
    root: data,
    current: data,
    index: undefined,
    inEach: false,
  });
}
