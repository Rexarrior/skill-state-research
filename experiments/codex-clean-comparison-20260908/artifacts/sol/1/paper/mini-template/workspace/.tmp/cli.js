// @bun
// src/engine.ts
var forbiddenKeys = new Set(["__proto__", "prototype", "constructor"]);
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
function parse(template) {
  const root = [];
  const stack = [];
  let current = root;
  let offset = 0;
  while (offset < template.length) {
    const start = template.indexOf("{{", offset);
    if (start === -1) {
      current.push({ kind: "text", value: template.slice(offset) });
      break;
    }
    if (start > offset) {
      current.push({ kind: "text", value: template.slice(offset, start) });
    }
    const triple = template.startsWith("{{{", start);
    const close = triple ? "}}}" : "}}";
    const contentStart = start + (triple ? 3 : 2);
    const end = template.indexOf(close, contentStart);
    const location = locationAt(template, start);
    if (end === -1) {
      throw syntaxError("Unclosed tag", location);
    }
    const content = template.slice(contentStart, end).trim();
    offset = end + close.length;
    if (triple) {
      if (!content)
        throw syntaxError("Empty interpolation", location);
      current.push({ kind: "value", path: content, escaped: false, location });
      continue;
    }
    if (content.startsWith("!"))
      continue;
    if (content === "else") {
      const frame = stack[stack.length - 1];
      if (!frame)
        throw syntaxError("else outside a block", location);
      if (frame.inElse)
        throw syntaxError("Duplicate else", location);
      frame.inElse = true;
      current = frame.alternate;
      continue;
    }
    if (content.startsWith("#")) {
      const match = /^#(if|each)(?:\s+)(.+)$/.exec(content);
      if (!match) {
        const name = content.slice(1).split(/\s/, 1)[0] || "(empty)";
        throw syntaxError(`Unknown or malformed block ${name}`, location);
      }
      const node = {
        kind: "block",
        block: match[1],
        path: match[2].trim(),
        body: [],
        alternate: [],
        location
      };
      if (!node.path)
        throw syntaxError(`Missing path for ${node.block}`, location);
      current.push(node);
      stack.push({ ...node, parent: current, inElse: false });
      current = node.body;
      continue;
    }
    if (content.startsWith("/")) {
      const name = content.slice(1).trim();
      const frame = stack[stack.length - 1];
      if (!frame)
        throw syntaxError(`Closing ${name || "block"} without an open block`, location);
      if (name !== frame.block) {
        throw syntaxError(`Mismatched close: expected /${frame.block}, got /${name}`, location);
      }
      stack.pop();
      current = frame.parent;
      continue;
    }
    if (!content)
      throw syntaxError("Empty interpolation", location);
    current.push({ kind: "value", path: content, escaped: true, location });
  }
  const unclosed = stack[stack.length - 1];
  if (unclosed)
    throw syntaxError(`Unclosed ${unclosed.block} block`, unclosed.location);
  return root;
}
function property(value, key) {
  if (value === null || value === undefined || forbiddenKeys.has(key)) {
    return { found: false, value: undefined };
  }
  if (typeof value !== "object" && typeof value !== "function" || !(key in value)) {
    return { found: false, value: undefined };
  }
  return { found: true, value: value[key] };
}
function walk(base, parts) {
  let value = base;
  for (const part of parts) {
    const result = property(value, part);
    if (!result.found)
      return result;
    value = result.value;
  }
  return { found: true, value };
}
function resolve(path, root, contexts) {
  if (path === "this")
    return contexts.length ? contexts[contexts.length - 1].value : root;
  if (path === "@index")
    return contexts.length ? contexts[contexts.length - 1].index : undefined;
  const parts = path.split(".");
  if (parts.some((part) => !part))
    return;
  if (parts[0] === "this") {
    const base = contexts.length ? contexts[contexts.length - 1].value : root;
    return walk(base, parts.slice(1)).value;
  }
  if (contexts.length) {
    const local = walk(contexts[contexts.length - 1].value, parts);
    if (local.found)
      return local.value;
  }
  return walk(root, parts).value;
}
function truthy(value) {
  if (Array.isArray(value))
    return value.length > 0;
  return value !== "" && value !== 0 && value !== false && value !== null && value !== undefined;
}
function scalar(value, path, location) {
  if (value === null || value === undefined)
    return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  throw syntaxError(`Value at ${path} cannot be rendered as scalar text`, location);
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
function renderNodes(nodes, root, contexts) {
  let output = "";
  for (const node of nodes) {
    if (node.kind === "text") {
      output += node.value;
    } else if (node.kind === "value") {
      const text = scalar(resolve(node.path, root, contexts), node.path, node.location);
      output += node.escaped ? escapeHtml(text) : text;
    } else {
      const value = resolve(node.path, root, contexts);
      if (node.block === "if") {
        output += renderNodes(truthy(value) ? node.body : node.alternate, root, contexts);
      } else if (Array.isArray(value) && value.length > 0) {
        for (let index = 0;index < value.length; index++) {
          output += renderNodes(node.body, root, [...contexts, { value: value[index], index }]);
        }
      } else {
        output += renderNodes(node.alternate, root, contexts);
      }
    }
  }
  return output;
}
function render(template, data) {
  return renderNodes(parse(template), data, []);
}

// src/cli.ts
async function main() {
  const [templatePath, dataPath, ...extra] = Bun.argv.slice(2);
  if (!templatePath || !dataPath || extra.length) {
    throw new Error("Usage: bun run src/cli.ts TEMPLATE_FILE DATA.json");
  }
  const [template, json] = await Promise.all([
    Bun.file(templatePath).text(),
    Bun.file(dataPath).text()
  ]);
  const data = JSON.parse(json);
  await Bun.write(Bun.stdout, render(template, data));
}
main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`mini-template: ${message}`);
  process.exitCode = 1;
});
