import { describe, expect, test } from "bun:test";
import { render } from "../src/engine";

describe("interpolation", () => {
  test("escapes HTML and supports raw values and missing values", () => {
    expect(render(`{{value}}|{{{value}}}|{{missing}}`, { value: `&<>\"'` }))
      .toBe(`&amp;&lt;&gt;&quot;&#39;|&<>\"'|`);
  });

  test("rejects non-scalar values", () => {
    expect(() => render("before {{value}}", { value: {} }))
      .toThrow(/Cannot render non-scalar value.*line 1, column 8/);
  });
});

describe("blocks", () => {
  test("implements the specified truthiness", () => {
    for (const value of ["", 0, false, null, undefined, []]) {
      expect(render("{{#if value}}yes{{else}}no{{/if}}", { value })).toBe("no");
    }
    for (const value of ["x", 1, true, {}, [0]]) {
      expect(render("{{#if value}}yes{{else}}no{{/if}}", { value })).toBe("yes");
    }
  });

  test("supports nested each, root fallback, this, and index", () => {
    const template = "{{#each groups}}[{{name}}/{{title}}:{{#each this.items}}{{@index}}={{this}};{{else}}empty{{/each}}]{{else}}none{{/each}}";
    const data = {
      title: "root",
      groups: [
        { name: "a", items: ["x", "y"] },
        { name: "b", items: [] },
      ],
    };
    expect(render(template, data)).toBe("[a/root:0=x;1=y;][b/root:empty]");
  });

  test("preserves whitespace and removes comments", () => {
    expect(render(" a\n{{! ignored }}\t b ", {})).toBe(" a\n\t b ");
  });
});

describe("syntax errors", () => {
  test.each([
    ["{{#wat x}}", /Unknown block.*line 1, column 1/],
    ["x\n{{else}}", /else outside.*line 2, column 1/],
    ["{{#if x}}{{else}}{{else}}{{/if}}", /Duplicate else.*column 18/],
    ["{{#if x}}{{/each}}", /Mismatched closing block.*column 10/],
    ["{{#each x}}", /Unclosed each block.*column 1/],
    ["{{value", /Unclosed tag.*column 1/],
  ])("reports a useful position for %s", (template, pattern) => {
    expect(() => render(template as string, {})).toThrow(pattern as RegExp);
  });
});
