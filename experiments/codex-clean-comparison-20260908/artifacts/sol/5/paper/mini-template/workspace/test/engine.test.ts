import { describe, expect, test } from "bun:test";
import { render } from "../src/engine";

describe("render", () => {
  test("escapes interpolations and supports raw values and missing values", () => {
    expect(render(`{{value}}|{{{value}}}|{{missing}}`, { value: `&<>"'` }))
      .toBe(`&amp;&lt;&gt;&quot;&#39;|&<>"'|`);
  });

  test("preserves whitespace and removes comments", () => {
    expect(render(" a \n{{! ignored }} b\t", {})).toBe(" a \n b\t");
  });

  test("handles nested conditionals and specified false values", () => {
    const template = "{{#if outer}}A{{#if inner}}B{{else}}C{{/if}}{{else}}D{{/if}}";
    expect(render(template, { outer: true, inner: 0 })).toBe("AC");
    expect(render(template, { outer: [] })).toBe("D");
    expect(render("{{#if value}}T{{else}}F{{/if}}", { value: {} })).toBe("T");
  });

  test("iterates nested arrays with this, index, local lookup, and root fallback", () => {
    const template = "{{#each groups}}[{{name}}/{{title}}:{{#each items}}{{@index}}={{this}};{{else}}empty{{/each}}]{{else}}none{{/each}}";
    expect(render(template, {
      title: "root",
      groups: [{ name: "a", items: ["x", "y"] }, { name: "b", items: [] }],
    })).toBe("[a/root:0=x;1=y;][b/root:empty]");
    expect(render("{{#each items}}x{{else}}empty{{/each}}", { items: "not-array" })).toBe("empty");
  });

  test("rejects non-scalar interpolation", () => {
    expect(() => render("before {{thing}}", { thing: { value: 1 } }))
      .toThrow(/Cannot render non-scalar value.*line 1, column 8/);
  });

  test.each([
    ["{{else}}", /outside a block.*line 1, column 1/],
    ["{{#wat x}}{{/wat}}", /Unknown or invalid block.*line 1, column 1/],
    ["{{#if x}}{{/each}}", /Mismatched closing tag.*line 1, column 10/],
    ["{{#if x}}", /Unclosed.*line 1, column/],
    ["{{#if x}}{{else}}{{else}}{{/if}}", /Duplicate.*line 1, column 18/],
  ])("reports structural error for %s", (template, pattern) => {
    expect(() => render(template, {})).toThrow(pattern);
  });
});
