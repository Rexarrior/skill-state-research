// @bun
// src/engine.ts
var MISSING = Symbol("missing");
function locationAt(source, offset) {
  let line = 1;
  let column = 1;
  for (let i = 0;i < offset; i++) {
    if (source.charCodeAt(i) === 10) {
      line++;
      column = 1;
    } else {
      column++;
    }
  }
  return { line, column };
}
function syntaxError(message, location) {
  return new Error(`${message} at line ${location.line}, column ${location.column}`);
}
function requirePath(path, description, location) {
  if (!path)
    throw syntaxError(`${description} requires a path`, location);
  return path;
}
function parse(template) {
  const root = [];
  const stack = [];
  let output = root;
  let cursor = 0;
  while (cursor < template.length) {
    const open = template.indexOf("{{", cursor);
    if (open === -1) {
      output.push({ type: "text", value: template.slice(cursor) });
      break;
    }
    if (open > cursor)
      output.push({ type: "text", value: template.slice(cursor, open) });
    const triple = template.startsWith("{{{", open);
    const closing = triple ? "}}}" : "}}";
    const contentStart = open + (triple ? 3 : 2);
    const close = template.indexOf(closing, contentStart);
    const location = locationAt(template, open);
    if (close === -1)
      throw syntaxError(`Unclosed ${triple ? "triple " : ""}tag`, location);
    const content = template.slice(contentStart, close).trim();
    cursor = close + closing.length;
    if (triple) {
      output.push({
        type: "value",
        path: requirePath(content, "Interpolation", location),
        escaped: false,
        location
      });
      continue;
    }
    if (content.startsWith("!"))
      continue;
    if (content.startsWith("#")) {
      const match = /^#(if|each)(?:\s+(.+))?$/.exec(content);
      if (!match) {
        const name = content.slice(1).trim().split(/\s/, 1)[0] || "(empty)";
        throw syntaxError(`Unknown block '${name}'`, location);
      }
      const path = requirePath((match[2] ?? "").trim(), `#${match[1]}`, location);
      const node = match[1] === "if" ? { type: "if", path, truthy: [], falsy: [], location } : { type: "each", path, items: [], empty: [], location };
      output.push(node);
      stack.push({ node, parent: output, hasElse: false });
      output = node.type === "if" ? node.truthy : node.items;
      continue;
    }
    if (content === "else") {
      const frame = stack.at(-1);
      if (!frame)
        throw syntaxError("'else' outside a block", location);
      if (frame.hasElse)
        throw syntaxError("Duplicate 'else'", location);
      frame.hasElse = true;
      output = frame.node.type === "if" ? frame.node.falsy : frame.node.empty;
      continue;
    }
    if (content.startsWith("/")) {
      const name = content.slice(1).trim();
      const frame = stack.at(-1);
      if (!frame)
        throw syntaxError(`Unexpected closing block '/${name}'`, location);
      if (name !== frame.node.type) {
        throw syntaxError(`Mismatched closing block: expected '/${frame.node.type}', got '/${name}'`, location);
      }
      stack.pop();
      output = frame.parent;
      continue;
    }
    output.push({
      type: "value",
      path: requirePath(content, "Interpolation", location),
      escaped: true,
      location
    });
  }
  const unclosed = stack.at(-1)?.node;
  if (unclosed)
    throw syntaxError(`Unclosed block '#${unclosed.type}'`, unclosed.location);
  return root;
}
function property(value, parts) {
  let current = value;
  for (const part of parts) {
    if (typeof current !== "object" && typeof current !== "function" || current === null)
      return MISSING;
    if (!Object.prototype.hasOwnProperty.call(current, part))
      return MISSING;
    current = current[part];
  }
  return current;
}
function resolve(path, context) {
  if (path === "this")
    return context.inEach ? context.current : property(context.root, ["this"]);
  if (path.startsWith("this.")) {
    if (!context.inEach)
      return property(context.root, path.split("."));
    return property(context.current, path.slice(5).split("."));
  }
  if (path === "@index")
    return context.inEach ? context.index : MISSING;
  const parts = path.split(".");
  if (parts.some((part) => part.length === 0))
    return MISSING;
  if (context.inEach) {
    const local = property(context.current, parts);
    if (local !== MISSING)
      return local;
  }
  return property(context.root, parts);
}
function truthy(value) {
  if (value === MISSING || value === null || value === undefined || value === false || value === 0 || value === "")
    return false;
  return !Array.isArray(value) || value.length > 0;
}
function scalar(value, path, location) {
  if (value === MISSING || value === null || value === undefined)
    return "";
  switch (typeof value) {
    case "string":
      return value;
    case "number":
    case "bigint":
    case "boolean":
      return String(value);
    default:
      throw syntaxError(`Value at '${path}' cannot be rendered as scalar text`, location);
  }
}
function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]);
}
function renderNodes(nodes, context) {
  let result = "";
  for (const node of nodes) {
    if (node.type === "text") {
      result += node.value;
    } else if (node.type === "value") {
      const text = scalar(resolve(node.path, context), node.path, node.location);
      result += node.escaped ? escapeHtml(text) : text;
    } else if (node.type === "if") {
      const branch = truthy(resolve(node.path, context)) ? node.truthy : node.falsy;
      result += renderNodes(branch, context);
    } else {
      const value = resolve(node.path, context);
      if (Array.isArray(value) && value.length > 0) {
        for (let index = 0;index < value.length; index++) {
          result += renderNodes(node.items, { ...context, current: value[index], index, inEach: true });
        }
      } else {
        result += renderNodes(node.empty, context);
      }
    }
  }
  return result;
}
function render(template, data) {
  return renderNodes(parse(template), { root: data, current: data, index: undefined, inEach: false });
}
export {
  render
};
