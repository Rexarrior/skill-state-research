type Position = {
  line: number;
  column: number;
};

type Token =
  | { kind: "text"; value: string; position: Position }
  | { kind: "tag"; value: string; raw: boolean; position: Position };

type Node =
  | { kind: "text"; value: string }
  | { kind: "value"; path: string; raw: boolean; position: Position }
  | {
      kind: "block";
      block: "if" | "each";
      path: string;
      consequent: Node[];
      alternate: Node[];
      position: Position;
    };

type EachContext = { value: unknown; index: number };

const MISSING = Symbol("missing");

function syntaxError(message: string, position: Position): Error {
  return new Error(`${message} at line ${position.line}, column ${position.column}`);
}

function tokenize(template: string): Token[] {
  const tokens: Token[] = [];
  let offset = 0;
  let line = 1;
  let column = 1;

  const advance = (text: string): void => {
    for (const character of text) {
      if (character === "\n") {
        line += 1;
        column = 1;
      } else {
        column += 1;
      }
    }
  };

  while (offset < template.length) {
    const opening = template.indexOf("{{", offset);
    if (opening === -1) {
      tokens.push({ kind: "text", value: template.slice(offset), position: { line, column } });
      break;
    }

    if (opening > offset) {
      const text = template.slice(offset, opening);
      tokens.push({ kind: "text", value: text, position: { line, column } });
      advance(text);
      offset = opening;
    }

    const position = { line, column };
    const raw = template.startsWith("{{{", offset);
    const openingLength = raw ? 3 : 2;
    const closing = raw ? "}}}" : "}}";
    const closeAt = template.indexOf(closing, offset + openingLength);
    if (closeAt === -1) {
      throw syntaxError("Unclosed tag", position);
    }

    const completeTag = template.slice(offset, closeAt + closing.length);
    const value = template.slice(offset + openingLength, closeAt).trim();
    tokens.push({ kind: "tag", value, raw, position });
    advance(completeTag);
    offset = closeAt + closing.length;
  }

  return tokens;
}

function validatePath(path: string, position: Position): void {
  if (path === "this" || path === "@index") return;
  if (!/^[A-Za-z_$][A-Za-z0-9_$-]*(?:\.[A-Za-z0-9_$-]+)*$/.test(path)) {
    throw syntaxError(`Invalid path ${JSON.stringify(path)}`, position);
  }
}

function parse(tokens: Token[]): Node[] {
  let cursor = 0;

  const parseSequence = (
    expectedBlock?: "if" | "each",
  ): { nodes: Node[]; terminator?: "else" | "close"; terminatorPosition?: Position } => {
    const nodes: Node[] = [];

    while (cursor < tokens.length) {
      const token = tokens[cursor++];
      if (token.kind === "text") {
        nodes.push({ kind: "text", value: token.value });
        continue;
      }

      const tag = token.value;
      if (tag.startsWith("!")) continue;

      if (tag === "else") {
        if (!expectedBlock) throw syntaxError("else outside a block", token.position);
        return { nodes, terminator: "else", terminatorPosition: token.position };
      }

      if (tag.startsWith("/")) {
        const name = tag.slice(1).trim();
        if (!expectedBlock) throw syntaxError(`Unexpected closing block ${JSON.stringify(name)}`, token.position);
        if (name !== expectedBlock) {
          throw syntaxError(
            `Mismatched closing block: expected /${expectedBlock}, received /${name}`,
            token.position,
          );
        }
        return { nodes, terminator: "close", terminatorPosition: token.position };
      }

      if (tag.startsWith("#")) {
        const match = /^#([^\s]+)(?:\s+(.+))?$/.exec(tag);
        const blockName = match?.[1];
        const path = match?.[2]?.trim() ?? "";
        if (blockName !== "if" && blockName !== "each") {
          throw syntaxError(`Unknown block ${JSON.stringify(blockName ?? tag.slice(1))}`, token.position);
        }
        validatePath(path, token.position);

        const consequentResult = parseSequence(blockName);
        if (!consequentResult.terminator) {
          throw syntaxError(`Unclosed block #${blockName}`, token.position);
        }

        let alternate: Node[] = [];
        if (consequentResult.terminator === "else") {
          const alternateResult = parseSequence(blockName);
          if (!alternateResult.terminator) {
            throw syntaxError(`Unclosed block #${blockName}`, token.position);
          }
          if (alternateResult.terminator === "else") {
            throw syntaxError("Duplicate else", alternateResult.terminatorPosition!);
          }
          alternate = alternateResult.nodes;
        }

        nodes.push({
          kind: "block",
          block: blockName,
          path,
          consequent: consequentResult.nodes,
          alternate,
          position: token.position,
        });
        continue;
      }

      if (tag === "") throw syntaxError("Empty tag", token.position);
      validatePath(tag, token.position);
      nodes.push({ kind: "value", path: tag, raw: token.raw, position: token.position });
    }

    return { nodes };
  };

  return parseSequence().nodes;
}

function lookup(object: unknown, segments: string[]): unknown | typeof MISSING {
  let current = object;
  for (const segment of segments) {
    if ((typeof current !== "object" || current === null) && typeof current !== "function") {
      return MISSING;
    }
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return MISSING;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function resolve(path: string, root: unknown, contexts: EachContext[]): unknown {
  const context = contexts.at(-1);
  if (path === "this") return context ? context.value : root;
  if (path === "@index") return context?.index;

  const segments = path.split(".");
  if (context) {
    const local = lookup(context.value, segments);
    if (local !== MISSING) return local;
  }
  const rootValue = lookup(root, segments);
  return rootValue === MISSING ? undefined : rootValue;
}

function isTruthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return !(value === "" || value === 0 || value === false || value === null || value === undefined);
}

function scalar(value: unknown, path: string, position: Position): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  throw syntaxError(`Value at ${JSON.stringify(path)} is not scalar text`, position);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      default: return "&#39;";
    }
  });
}

function renderNodes(nodes: Node[], root: unknown, contexts: EachContext[]): string {
  let output = "";
  for (const node of nodes) {
    if (node.kind === "text") {
      output += node.value;
    } else if (node.kind === "value") {
      const text = scalar(resolve(node.path, root, contexts), node.path, node.position);
      output += node.raw ? text : escapeHtml(text);
    } else {
      const value = resolve(node.path, root, contexts);
      if (node.block === "if") {
        output += renderNodes(isTruthy(value) ? node.consequent : node.alternate, root, contexts);
      } else if (Array.isArray(value) && value.length > 0) {
        for (let index = 0; index < value.length; index += 1) {
          output += renderNodes(node.consequent, root, [...contexts, { value: value[index], index }]);
        }
      } else {
        output += renderNodes(node.alternate, root, contexts);
      }
    }
  }
  return output;
}

/** Render a Mini Template string with the supplied data. */
export function render(template: string, data: unknown): string {
  return renderNodes(parse(tokenize(template)), data, []);
}
