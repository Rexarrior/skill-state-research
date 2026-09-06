// @bun
// src/engine.ts
var MISSING = Symbol("missing");
function locationAt(source, offset) {
  let line = 1;
  let column = 1;
  for (let index = 0;index < offset; index += 1) {
    if (source[index] === `
`) {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { line, column };
}
function syntaxError(message, location) {
  return new Error(`${message} at line ${location.line}, column ${location.column}`);
}
function requirePath(path, kind, location) {
  if (path.length === 0) {
    throw syntaxError(`${kind} requires a path`, location);
  }
  return path;
}
function parse(template) {
  const root = [];
  const stack = [];
  let current = root;
  let cursor = 0;
  while (cursor < template.length) {
    const start = template.indexOf("{{", cursor);
    if (start === -1) {
      current.push({ type: "text", value: template.slice(cursor) });
      break;
    }
    if (start > cursor) {
      current.push({ type: "text", value: template.slice(cursor, start) });
    }
    const triple = template.startsWith("{{{", start);
    const closing = triple ? "}}}" : "}}";
    const contentStart = start + (triple ? 3 : 2);
    const end = template.indexOf(closing, contentStart);
    const location = locationAt(template, start);
    if (end === -1) {
      throw syntaxError("Unclosed template tag", location);
    }
    const content = template.slice(contentStart, end).trim();
    cursor = end + closing.length;
    if (triple) {
      current.push({
        type: "value",
        path: requirePath(content, "Interpolation", location),
        escaped: false,
        location
      });
      continue;
    }
    if (content.startsWith("!"))
      continue;
    if (content === "else") {
      const frame = stack.at(-1);
      if (!frame)
        throw syntaxError("Unexpected else outside a block", location);
      if (frame.inElse)
        throw syntaxError("Duplicate else", location);
      frame.inElse = true;
      current = frame.node.alternate;
      continue;
    }
    if (content.startsWith("#")) {
      const match = /^#(if|each)(?:\s+(.+))?$/.exec(content);
      if (!match) {
        const name = content.slice(1).split(/\s/, 1)[0] || "(empty)";
        throw syntaxError(`Unknown block '${name}'`, location);
      }
      const type = match[1];
      const node = {
        type,
        path: requirePath(match[2]?.trim() ?? "", `#${type}`, location),
        body: [],
        alternate: [],
        location
      };
      current.push(node);
      stack.push({ node, parent: current, inElse: false });
      current = node.body;
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
      current = frame.parent;
      continue;
    }
    current.push({
      type: "value",
      path: requirePath(content, "Interpolation", location),
      escaped: true,
      location
    });
  }
  const unclosed = stack.at(-1);
  if (unclosed) {
    throw syntaxError(`Unclosed block '#${unclosed.node.type}'`, unclosed.node.location);
  }
  return root;
}
function lookup(value, path) {
  let current = value;
  for (const part of path.split(".")) {
    if (current === null || current === undefined || typeof current !== "object" && typeof current !== "function" || !Object.prototype.hasOwnProperty.call(current, part)) {
      return MISSING;
    }
    current = current[part];
  }
  return current;
}
function resolve(path, context) {
  const active = context.items.at(-1);
  if (path === "this")
    return active ? active.value : context.root;
  if (path.startsWith("this.")) {
    return lookup(active ? active.value : context.root, path.slice(5));
  }
  if (path === "@index")
    return active ? active.index : MISSING;
  if (path.startsWith("@"))
    return MISSING;
  if (active) {
    const local = lookup(active.value, path);
    if (local !== MISSING)
      return local;
  }
  return lookup(context.root, path);
}
function isTruthy(value) {
  if (value === MISSING || value === null || value === undefined)
    return false;
  if (value === false || value === 0 || value === "")
    return false;
  if (Array.isArray(value) && value.length === 0)
    return false;
  return true;
}
function scalarText(value, path, location) {
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
      throw syntaxError(`Value '${path}' is not scalar and cannot be rendered`, location);
  }
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
function renderNodes(nodes, context) {
  let output = "";
  for (const node of nodes) {
    if (node.type === "text") {
      output += node.value;
    } else if (node.type === "value") {
      const text = scalarText(resolve(node.path, context), node.path, node.location);
      output += node.escaped ? escapeHtml(text) : text;
    } else if (node.type === "if") {
      const branch = isTruthy(resolve(node.path, context)) ? node.body : node.alternate;
      output += renderNodes(branch, context);
    } else {
      const value = resolve(node.path, context);
      if (Array.isArray(value) && value.length > 0) {
        value.forEach((item, index) => {
          context.items.push({ value: item, index });
          try {
            output += renderNodes(node.body, context);
          } finally {
            context.items.pop();
          }
        });
      } else {
        output += renderNodes(node.alternate, context);
      }
    }
  }
  return output;
}
function render(template, data) {
  return renderNodes(parse(template), { root: data, items: [] });
}

// src/cli.ts
async function main() {
  const [templatePath, dataPath, extra] = Bun.argv.slice(2);
  if (!templatePath || !dataPath || extra) {
    throw new Error("Usage: bun run src/cli.ts TEMPLATE_FILE DATA.json");
  }
  const [template, json] = await Promise.all([
    Bun.file(templatePath).text(),
    Bun.file(dataPath).text()
  ]);
  const data = JSON.parse(json);
  process.stdout.write(render(template, data));
}
main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`mini-template: ${message}
`);
  process.exitCode = 1;
});
