// @bun
// src/engine.ts
function positionAt(source, offset) {
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
  return { offset, line, column };
}
function syntaxError(message, position) {
  return new Error(`${message} at line ${position.line}, column ${position.column}`);
}
function validatePath(path, position) {
  if (!path)
    throw syntaxError("Expected a path", position);
  if (path === "this" || path === "@index")
    return;
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/.test(path)) {
    throw syntaxError(`Invalid path "${path}"`, position);
  }
}
function parse(template) {
  const root = [];
  const stack = [];
  let target = root;
  let cursor = 0;
  while (cursor < template.length) {
    const open = template.indexOf("{{", cursor);
    if (open === -1) {
      target.push({ type: "text", value: template.slice(cursor) });
      break;
    }
    if (open > cursor)
      target.push({ type: "text", value: template.slice(cursor, open) });
    const triple = template.startsWith("{{{", open);
    const closing = triple ? "}}}" : "}}";
    const contentStart = open + (triple ? 3 : 2);
    const close = template.indexOf(closing, contentStart);
    const position = positionAt(template, open);
    if (close === -1)
      throw syntaxError("Unclosed tag", position);
    const raw = template.slice(contentStart, close).trim();
    cursor = close + closing.length;
    if (triple) {
      validatePath(raw, position);
      target.push({ type: "value", path: raw, escaped: false, position });
      continue;
    }
    if (raw.startsWith("!"))
      continue;
    if (raw === "else") {
      const frame = stack.at(-1);
      if (!frame)
        throw syntaxError("Unexpected else outside a block", position);
      if (frame.inAlternate)
        throw syntaxError("Duplicate else", position);
      frame.inAlternate = true;
      frame.block.alternate = [];
      target = frame.block.alternate;
      continue;
    }
    if (raw.startsWith("#")) {
      const match = /^#(\S+)(?:\s+(.+?))?$/.exec(raw);
      const name = match?.[1] ?? "";
      const path = match?.[2] ?? "";
      if (name !== "if" && name !== "each") {
        throw syntaxError(`Unknown block "${name}"`, position);
      }
      validatePath(path, position);
      const block = { type: name, path, body: [], alternate: null, position };
      target.push(block);
      stack.push({ block, parent: target, inAlternate: false });
      target = block.body;
      continue;
    }
    if (raw.startsWith("/")) {
      const name = raw.slice(1).trim();
      const frame = stack.at(-1);
      if (!frame)
        throw syntaxError(`Unexpected closing block "${name}"`, position);
      if (name !== frame.block.type) {
        throw syntaxError(`Mismatched closing block: expected /${frame.block.type}, got /${name}`, position);
      }
      stack.pop();
      target = frame.parent;
      continue;
    }
    validatePath(raw, position);
    target.push({ type: "value", path: raw, escaped: true, position });
  }
  const unclosed = stack.at(-1);
  if (unclosed) {
    throw syntaxError(`Unclosed ${unclosed.block.type} block`, unclosed.block.position);
  }
  return root;
}
function getProperty(value, part) {
  if ((typeof value !== "object" || value === null) && typeof value !== "function")
    return;
  if (!Object.prototype.hasOwnProperty.call(value, part))
    return;
  return value[part];
}
function follow(value, parts) {
  let result = value;
  for (const part of parts) {
    result = getProperty(result, part);
    if (result === undefined)
      break;
  }
  return result;
}
function resolve(path, context) {
  if (path === "this")
    return context.current;
  if (path === "@index")
    return context.index;
  const parts = path.split(".");
  const local = follow(context.current, parts);
  return local === undefined ? follow(context.root, parts) : local;
}
function isTruthy(value) {
  if (Array.isArray(value))
    return value.length > 0;
  return value !== "" && value !== 0 && value !== false && value !== null && value !== undefined;
}
function scalar(value, node) {
  if (value === null || value === undefined)
    return "";
  switch (typeof value) {
    case "string":
    case "number":
    case "boolean":
    case "bigint":
      return String(value);
    default:
      throw syntaxError(`Cannot render ${typeof value === "object" ? "an object" : `a ${typeof value}`} as scalar text`, node.position);
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
function evaluate(nodes, context) {
  let output = "";
  for (const node of nodes) {
    if (node.type === "text") {
      output += node.value;
    } else if (node.type === "value") {
      const value = scalar(resolve(node.path, context), node);
      output += node.escaped ? escapeHtml(value) : value;
    } else if (node.type === "if") {
      const branch = isTruthy(resolve(node.path, context)) ? node.body : node.alternate;
      if (branch)
        output += evaluate(branch, context);
    } else {
      const value = resolve(node.path, context);
      if (Array.isArray(value) && value.length > 0) {
        for (let index = 0;index < value.length; index++) {
          output += evaluate(node.body, { root: context.root, current: value[index], index });
        }
      } else if (node.alternate) {
        output += evaluate(node.alternate, context);
      }
    }
  }
  return output;
}
function render(template, data) {
  return evaluate(parse(template), { root: data, current: data, index: undefined });
}

// src/cli.ts
async function main() {
  const [templateFile, dataFile, ...extra] = Bun.argv.slice(2);
  if (!templateFile || !dataFile || extra.length > 0) {
    throw new Error("Usage: bun run src/cli.ts TEMPLATE_FILE DATA.json");
  }
  const [template, json] = await Promise.all([
    Bun.file(templateFile).text(),
    Bun.file(dataFile).text()
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
