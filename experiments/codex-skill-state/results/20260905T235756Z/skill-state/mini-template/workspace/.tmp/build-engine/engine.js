// src/engine.ts
var MISSING = Symbol("missing");
function positionAt(source, offset) {
  let line = 1;
  let column = 1;
  for (let i = 0;i < offset; i += 1) {
    if (source.charCodeAt(i) === 10) {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { line, column };
}
function syntaxError(message, position) {
  return new Error(`${message} at line ${position.line}, column ${position.column}`);
}
function parse(source) {
  const root = [];
  const stack = [];
  let output = root;
  let cursor = 0;
  while (cursor < source.length) {
    const start = source.indexOf("{{", cursor);
    if (start === -1) {
      output.push({ kind: "text", value: source.slice(cursor) });
      break;
    }
    if (start > cursor) {
      output.push({ kind: "text", value: source.slice(cursor, start) });
    }
    const triple = source.startsWith("{{{", start);
    const closing = triple ? "}}}" : "}}";
    const contentStart = start + (triple ? 3 : 2);
    const end = source.indexOf(closing, contentStart);
    const position = positionAt(source, start);
    if (end === -1) {
      throw syntaxError("Unclosed template tag", position);
    }
    const tag = source.slice(contentStart, end).trim();
    cursor = end + closing.length;
    if (triple) {
      if (!tag)
        throw syntaxError("Interpolation path cannot be empty", position);
      output.push({ kind: "value", path: tag, escaped: false, position });
      continue;
    }
    if (tag.startsWith("!"))
      continue;
    if (tag === "else") {
      const open = stack.at(-1);
      if (!open)
        throw syntaxError("'else' outside a block", position);
      if (open.inAlternate)
        throw syntaxError("Duplicate 'else'", position);
      open.inAlternate = true;
      output = open.node.alternate;
      continue;
    }
    if (tag.startsWith("#")) {
      const match = /^#([^\s]+)(?:\s+(.+))?$/.exec(tag);
      const name = match?.[1] ?? "";
      const path = match?.[2]?.trim() ?? "";
      if (name !== "if" && name !== "each") {
        throw syntaxError(`Unknown block '${name || tag}'`, position);
      }
      if (!path)
        throw syntaxError(`Block '${name}' requires a path`, position);
      const node = {
        kind: name,
        path,
        body: [],
        alternate: [],
        position
      };
      output.push(node);
      stack.push({ node, parent: output, inAlternate: false });
      output = node.body;
      continue;
    }
    if (tag.startsWith("/")) {
      const name = tag.slice(1).trim();
      const open = stack.at(-1);
      if (!open)
        throw syntaxError(`Closing '${name}' without an open block`, position);
      if (name !== open.node.kind) {
        throw syntaxError(`Mismatched closing block '${name}'; expected '${open.node.kind}'`, position);
      }
      stack.pop();
      output = open.parent;
      continue;
    }
    if (!tag)
      throw syntaxError("Interpolation path cannot be empty", position);
    output.push({ kind: "value", path: tag, escaped: true, position });
  }
  const unclosed = stack.at(-1);
  if (unclosed) {
    throw syntaxError(`Unclosed '${unclosed.node.kind}' block`, unclosed.node.position);
  }
  return root;
}
function property(value, parts) {
  let current = value;
  for (const part of parts) {
    if ((typeof current !== "object" || current === null) && typeof current !== "function") {
      return MISSING;
    }
    if (!Object.prototype.hasOwnProperty.call(current, part))
      return MISSING;
    current = current[part];
  }
  return current;
}
function resolve(path, scope) {
  if (path === "this")
    return scope.inEach ? scope.current : property(scope.root, ["this"]);
  if (path.startsWith("this.")) {
    if (!scope.inEach)
      return property(scope.root, path.split("."));
    return property(scope.current, path.slice(5).split("."));
  }
  if (path === "@index")
    return scope.inEach ? scope.index : MISSING;
  const parts = path.split(".");
  if (parts.some((part) => part.length === 0))
    return MISSING;
  if (scope.inEach) {
    const local = property(scope.current, parts);
    if (local !== MISSING)
      return local;
  }
  return property(scope.root, parts);
}
function isTruthy(value) {
  if (value === MISSING || value === null || value === undefined)
    return false;
  if (Array.isArray(value))
    return value.length > 0;
  return value !== "" && value !== 0 && value !== false;
}
function scalar(value, path, position) {
  if (value === MISSING || value === null || value === undefined)
    return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    return String(value);
  }
  throw syntaxError(`Value at '${path}' is not a renderable scalar`, position);
}
function escapeHtml(value) {
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
function renderNodes(nodes, scope) {
  let result = "";
  for (const node of nodes) {
    if (node.kind === "text") {
      result += node.value;
      continue;
    }
    if (node.kind === "value") {
      const text = scalar(resolve(node.path, scope), node.path, node.position);
      result += node.escaped ? escapeHtml(text) : text;
      continue;
    }
    const value = resolve(node.path, scope);
    if (node.kind === "if") {
      result += renderNodes(isTruthy(value) ? node.body : node.alternate, scope);
      continue;
    }
    if (Array.isArray(value) && value.length > 0) {
      value.forEach((item, index) => {
        result += renderNodes(node.body, {
          root: scope.root,
          current: item,
          index,
          inEach: true
        });
      });
    } else {
      result += renderNodes(node.alternate, scope);
    }
  }
  return result;
}
function render(template, data) {
  const nodes = parse(template);
  return renderNodes(nodes, { root: data, current: data, index: undefined, inEach: false });
}
export {
  render
};
