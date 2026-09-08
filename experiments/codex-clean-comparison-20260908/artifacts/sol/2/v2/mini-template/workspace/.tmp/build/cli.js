// @bun
// src/engine.ts
class TemplateError extends Error {
  constructor(message, location) {
    super(`${message} at line ${location.line}, column ${location.column}`);
    this.name = "TemplateError";
  }
}
function locationAt(template, offset) {
  let line = 1;
  let column = 1;
  for (let i = 0;i < offset; i++) {
    if (template.charCodeAt(i) === 10) {
      line++;
      column = 1;
    } else {
      column++;
    }
  }
  return { offset, line, column };
}
function validatePath(path, location) {
  const trimmed = path.trim();
  if (!trimmed || /\s/.test(trimmed) || trimmed.split(".").some((part) => !part)) {
    throw new TemplateError(`Invalid path ${JSON.stringify(trimmed)}`, location);
  }
  return trimmed;
}
function parse(template) {
  const root = [];
  const stack = [];
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
    const closingText = triple ? "}}}" : "}}";
    const contentStart = opening + (triple ? 3 : 2);
    const closing = template.indexOf(closingText, contentStart);
    const location = locationAt(template, opening);
    if (closing === -1) {
      throw new TemplateError("Unclosed tag", location);
    }
    const raw = template.slice(contentStart, closing);
    const tag = raw.trim();
    cursor = closing + closingText.length;
    if (triple) {
      output.push({
        kind: "value",
        path: validatePath(tag, location),
        escaped: false,
        location
      });
      continue;
    }
    if (tag.startsWith("!"))
      continue;
    if (tag.startsWith("#")) {
      const match = /^#(\S+)(?:\s+(.+?))?\s*$/.exec(tag);
      const name = match?.[1] ?? "";
      if (name !== "if" && name !== "each") {
        throw new TemplateError(`Unknown block ${JSON.stringify(name)}`, location);
      }
      const path = validatePath(match?.[2] ?? "", location);
      const block = {
        kind: name,
        path,
        consequent: [],
        alternate: [],
        location
      };
      output.push(block);
      stack.push({ block, parent: output, inElse: false });
      output = block.consequent;
      continue;
    }
    if (tag === "else") {
      const frame = stack.at(-1);
      if (!frame)
        throw new TemplateError("else outside a block", location);
      if (frame.inElse)
        throw new TemplateError("Duplicate else", location);
      frame.inElse = true;
      output = frame.block.alternate;
      continue;
    }
    if (tag.startsWith("/")) {
      const name = tag.slice(1).trim();
      const frame = stack.at(-1);
      if (!frame) {
        throw new TemplateError(`Closing ${JSON.stringify(name)} without an open block`, location);
      }
      if (name !== frame.block.kind) {
        throw new TemplateError(`Mismatched closing block: expected /${frame.block.kind}, got /${name}`, location);
      }
      stack.pop();
      output = frame.parent;
      continue;
    }
    output.push({
      kind: "value",
      path: validatePath(tag, location),
      escaped: true,
      location
    });
  }
  const unclosed = stack.at(-1);
  if (unclosed) {
    throw new TemplateError(`Unclosed ${unclosed.block.kind} block`, unclosed.block.location);
  }
  return root;
}
function property(value, segment) {
  if (typeof value !== "object" && typeof value !== "function" || value === null) {
    return { found: false, value: undefined };
  }
  if (!(segment in value))
    return { found: false, value: undefined };
  return { found: true, value: value[segment] };
}
function descend(value, segments) {
  let result = value;
  for (const segment of segments) {
    const next = property(result, segment);
    if (!next.found)
      return next;
    result = next.value;
  }
  return { found: true, value: result };
}
function resolve(path, scope) {
  if (path === "this")
    return scope.inEach ? scope.current : scope.root;
  if (path === "@index")
    return scope.inEach ? scope.index : undefined;
  if (path.startsWith("this.")) {
    return descend(scope.inEach ? scope.current : scope.root, path.slice(5).split(".")).value;
  }
  const segments = path.split(".");
  if (scope.inEach) {
    const local = descend(scope.current, segments);
    if (local.found)
      return local.value;
  }
  return descend(scope.root, segments).value;
}
function truthy(value) {
  if (Array.isArray(value))
    return value.length > 0;
  return value !== "" && value !== 0 && value !== false && value != null;
}
function scalar(value, path, location) {
  if (value == null)
    return "";
  switch (typeof value) {
    case "string":
      return value;
    case "number":
    case "boolean":
    case "bigint":
      return String(value);
    default:
      throw new TemplateError(`Value at ${JSON.stringify(path)} cannot be rendered as scalar text (got ${typeof value})`, location);
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
function renderNodes(nodes, scope) {
  let result = "";
  for (const node of nodes) {
    if (node.kind === "text") {
      result += node.value;
      continue;
    }
    if (node.kind === "value") {
      const value2 = scalar(resolve(node.path, scope), node.path, node.location);
      result += node.escaped ? escapeHtml(value2) : value2;
      continue;
    }
    const value = resolve(node.path, scope);
    if (node.kind === "if") {
      result += renderNodes(truthy(value) ? node.consequent : node.alternate, scope);
    } else if (Array.isArray(value) && value.length > 0) {
      for (let index = 0;index < value.length; index++) {
        result += renderNodes(node.consequent, {
          root: scope.root,
          current: value[index],
          index,
          inEach: true
        });
      }
    } else {
      result += renderNodes(node.alternate, scope);
    }
  }
  return result;
}
function render(template, data) {
  return renderNodes(parse(template), {
    root: data,
    current: data,
    index: undefined,
    inEach: false
  });
}

// src/cli.ts
async function main() {
  const [templatePath, dataPath, ...extra] = Bun.argv.slice(2);
  if (!templatePath || !dataPath || extra.length > 0) {
    throw new Error("Usage: bun run src/cli.ts TEMPLATE_FILE DATA.json");
  }
  const [template, json] = await Promise.all([
    Bun.file(templatePath).text(),
    Bun.file(dataPath).text()
  ]);
  const data = JSON.parse(json);
  process.stdout.write(render(template, data));
}
try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`mini-template: ${message}
`);
  process.exitCode = 1;
}
