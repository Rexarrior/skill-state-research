// @bun
// src/engine.ts
var MISSING = Symbol("missing");
function positionAt(template, index) {
  let line = 1;
  let column = 1;
  for (let i = 0;i < index; i++) {
    if (template.charCodeAt(i) === 10) {
      line++;
      column = 1;
    } else {
      column++;
    }
  }
  return { index, line, column };
}
function syntaxError(position, message) {
  return new Error(`Template error at line ${position.line}, column ${position.column}: ${message}`);
}
function requirePath(expression, kind, position) {
  const path = expression.trim();
  if (!path)
    throw syntaxError(position, `${kind} requires a path`);
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
    if (open > cursor) {
      output.push({ type: "text", value: template.slice(cursor, open) });
    }
    const triple = template.startsWith("{{{", open);
    const closeToken = triple ? "}}}" : "}}";
    const contentStart = open + (triple ? 3 : 2);
    const close = template.indexOf(closeToken, contentStart);
    const position = positionAt(template, open);
    if (close === -1) {
      throw syntaxError(position, `unclosed ${triple ? "triple" : "double"} tag`);
    }
    const raw = template.slice(contentStart, close);
    const expression = raw.trim();
    cursor = close + closeToken.length;
    if (triple) {
      output.push({
        type: "value",
        path: requirePath(expression, "interpolation", position),
        escaped: false,
        position
      });
      continue;
    }
    if (expression.startsWith("!"))
      continue;
    if (expression === "else") {
      const active = stack[stack.length - 1];
      if (!active)
        throw syntaxError(position, "else outside a block");
      if (active.inElse)
        throw syntaxError(position, "duplicate else");
      active.inElse = true;
      output = active.node.inverse;
      continue;
    }
    if (expression.startsWith("#")) {
      const match = /^#(\S+)(?:\s+([\s\S]*))?$/.exec(expression);
      const name = match?.[1] ?? expression.slice(1);
      if (name !== "if" && name !== "each") {
        throw syntaxError(position, `unknown block "${name}"`);
      }
      const path = requirePath(match?.[2] ?? "", `${name} block`, position);
      const node = {
        type: name,
        path,
        body: [],
        inverse: [],
        position
      };
      output.push(node);
      stack.push({ node, parent: output, inElse: false });
      output = node.body;
      continue;
    }
    if (expression.startsWith("/")) {
      const name = expression.slice(1).trim();
      const active = stack[stack.length - 1];
      if (!active) {
        throw syntaxError(position, `closing block "${name}" without an open block`);
      }
      if (name !== active.node.type) {
        throw syntaxError(position, `mismatched closing block "${name}"; expected "${active.node.type}"`);
      }
      stack.pop();
      output = active.parent;
      continue;
    }
    output.push({
      type: "value",
      path: requirePath(expression, "interpolation", position),
      escaped: true,
      position
    });
  }
  const unclosed = stack[stack.length - 1];
  if (unclosed) {
    throw syntaxError(unclosed.node.position, `unclosed ${unclosed.node.type} block`);
  }
  return root;
}
function property(value, key) {
  if (value === null || value === undefined)
    return MISSING;
  if (typeof value !== "object" && typeof value !== "function" || !(key in value)) {
    return MISSING;
  }
  return value[key];
}
function walk(value, parts) {
  let result = value;
  for (const part of parts) {
    if (result === MISSING)
      return MISSING;
    result = property(result, part);
  }
  return result;
}
function resolve(path, context) {
  if (path === "@index")
    return context.inEach ? context.index : MISSING;
  if (path === "this")
    return context.inEach ? context.current : MISSING;
  if (path.startsWith("this.")) {
    return context.inEach ? walk(context.current, path.slice(5).split(".")) : MISSING;
  }
  const parts = path.split(".");
  if (context.inEach) {
    const local = walk(context.current, parts);
    if (local !== MISSING)
      return local;
  }
  return walk(context.root, parts);
}
function truthy(value) {
  if (value === MISSING || value === null || value === undefined)
    return false;
  if (value === "" || value === 0 || value === false)
    return false;
  if (Array.isArray(value) && value.length === 0)
    return false;
  return true;
}
function scalar(value, position) {
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
      throw syntaxError(position, `cannot render ${Array.isArray(value) ? "an array" : typeof value} as scalar text`);
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
  let result = "";
  for (const node of nodes) {
    if (node.type === "text") {
      result += node.value;
      continue;
    }
    if (node.type === "value") {
      const text = scalar(resolve(node.path, context), node.position);
      result += node.escaped ? escapeHtml(text) : text;
      continue;
    }
    const value = resolve(node.path, context);
    if (node.type === "if") {
      result += renderNodes(truthy(value) ? node.body : node.inverse, context);
      continue;
    }
    if (Array.isArray(value) && value.length > 0) {
      for (let index = 0;index < value.length; index++) {
        result += renderNodes(node.body, {
          root: context.root,
          current: value[index],
          index,
          inEach: true
        });
      }
    } else {
      result += renderNodes(node.inverse, context);
    }
  }
  return result;
}
function render(template, data) {
  const nodes = parse(template);
  return renderNodes(nodes, {
    root: data,
    current: data,
    index: undefined,
    inEach: false
  });
}

// src/cli.ts
async function main() {
  const args = Bun.argv.slice(2);
  if (args.length !== 2) {
    throw new Error("Usage: bun run src/cli.ts TEMPLATE_FILE DATA.json");
  }
  const [templateFile, dataFile] = args;
  const template = await Bun.file(templateFile).text();
  const dataText = await Bun.file(dataFile).text();
  let data;
  try {
    data = JSON.parse(dataText);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in ${dataFile}: ${detail}`);
  }
  await Bun.write(Bun.stdout, render(template, data));
}
main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
