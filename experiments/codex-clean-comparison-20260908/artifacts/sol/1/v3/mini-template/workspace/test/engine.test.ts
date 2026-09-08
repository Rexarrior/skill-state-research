import { describe, expect, test } from "bun:test";
import { render } from "../src/engine";

describe("render", () => {
  test("escapes interpolations and preserves raw interpolations", () => {
    expect(render(`{{value}}|{{{value}}}`, { value: `&<>"'` }))
      .toBe(`&amp;&lt;&gt;&quot;&#39;|&<>"'`);
  });

  test("renders missing values as empty and preserves whitespace", () => {
    expect(render(" a\n {{missing}} \t b ", {})).toBe(" a\n  \t b ");
  });

  test("supports nested conditionals, else, and specified truthiness", () => {
    const template = "{{#if outer}}A{{#if inner}}B{{else}}C{{/if}}{{else}}D{{/if}}";
    expect(render(template, { outer: true, inner: 0 })).toBe("AC");
    expect(render(template, { outer: [], inner: true })).toBe("D");
    expect(render("{{#if value}}yes{{else}}no{{/if}}", { value: {} })).toBe("yes");
  });

  test("iterates arrays with this, index, fields, root fallback, and nesting", () => {
    const template = "{{#each groups}}[{{name}}/{{title}}:{{#each items}}{{@index}}={{this}};{{else}}empty{{/each}}]{{/each}}";
    const data = { title: "T", groups: [{ name: "A", items: ["x", "y"] }, { name: "B", items: [] }] };
    expect(render(template, data)).toBe("[A/T:0=x;1=y;][B/T:empty]");
  });

  test("comments emit nothing", () => {
    expect(render("a{{! ignored }}b", {})).toBe("ab");
  });

  test("rejects non-scalar interpolation", () => {
    expect(() => render("line\n{{user}}", { user: { name: "Ada" } }))
      .toThrow(/not scalar.*line 2, column 1/);
  });

  test.each([
    ["{{#wat x}}{{/wat}}", /Unknown block.*line 1, column 1/],
    ["{{#if x}}{{/each}}", /Mismatched.*line 1, column 10/],
    ["{{#if x}}", /Unclosed #if.*line 1, column 1/],
    ["x\n{{else}}", /outside.*line 2, column 1/],
    ["{{#each x}}{{else}}{{else}}{{/each}}", /Duplicate else.*column 20/],
    ["{{/if}}", /without an open block.*line 1, column 1/],
  ])("reports structural error for %s", (template, pattern) => {
    expect(() => render(template, {})).toThrow(pattern as RegExp);
  });
});
