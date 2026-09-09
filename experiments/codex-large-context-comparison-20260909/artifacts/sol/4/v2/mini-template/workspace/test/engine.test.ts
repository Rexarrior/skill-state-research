import { describe, expect, test } from "bun:test";
import { render } from "../src/engine";

describe("render", () => {
  test("interpolates escaped and raw values and preserves whitespace", () => {
    expect(render(" A {{value}} / {{{value}}}\n", { value: `&<>\"'` }))
      .toBe(" A &amp;&lt;&gt;&quot;&#39; / &<>\"'\n");
  });

  test("missing values are empty and scalar primitives render", () => {
    expect(render("{{missing}}|{{n}}|{{b}}|{{nil}}", { n: 12, b: false, nil: null }))
      .toBe("|12|false|");
  });

  test("if uses the specified truthiness and supports nesting", () => {
    expect(render("{{#if outer}}A{{#if inner}}B{{else}}C{{/if}}{{else}}D{{/if}}", {
      outer: [], inner: true,
    })).toBe("D");
    expect(render("{{#if outer}}A{{#if inner}}B{{else}}C{{/if}}{{/if}}", {
      outer: {}, inner: 0,
    })).toBe("AC");
  });

  test("each exposes locals, falls back to root, and nests", () => {
    const template = "{{#each rows}}[{{@index}}={{this}}/{{title}}:{{#each suffixes}}{{this}}{{@index}}{{else}}none{{/each}}]{{else}}empty{{/each}}";
    expect(render(template, { title: "T", rows: ["a", "b"], suffixes: ["x", "y"] }))
      .toBe("[0=a/T:x0y1][1=b/T:x0y1]");
    expect(render("{{#each rows}}x{{else}}empty{{/each}}", { rows: [] })).toBe("empty");
    expect(render("{{#each rows}}x{{else}}empty{{/each}}", { rows: "not-array" })).toBe("empty");
  });

  test("comments emit nothing", () => {
    expect(render("a{{! ignore {{ stuff }}b", {})).toBe("ab");
  });

  test("rejects non-scalars", () => {
    expect(() => render("{{value}}", { value: {} })).toThrow("cannot be rendered as scalar text");
    expect(() => render("{{value}}", { value: [] })).toThrow("cannot be rendered as scalar text");
  });

  test.each([
    ["{{#wat x}}{{/wat}}", "Unknown or malformed block", "line 1, column 1"],
    ["{{else}}", "else outside a block", "line 1, column 1"],
    ["{{#if x}}{{else}}{{else}}{{/if}}", "Duplicate else", "line 1, column 18"],
    ["{{#if x}}\n{{/each}}", "Mismatched closing block", "line 2, column 1"],
    ["x\n{{#if x}}", "Unclosed if block", "line 2, column 1"],
    ["{{/if}}", "without an open block", "line 1, column 1"],
    ["hello {{name", "Unclosed tag", "line 1, column 7"],
  ])("reports structural error for %s", (template, message, location) => {
    expect(() => render(template, {})).toThrow(message);
    expect(() => render(template, {})).toThrow(location);
  });
});
