import { describe, expect, test } from "bun:test";
import { render } from "../src/engine";

describe("render", () => {
  test("interpolates escaped and raw scalar values", () => {
    const data = { value: `&<>"'`, missing: undefined };
    expect(render("{{value}}|{{{value}}}|{{missing}}|{{nope}}", data)).toBe(
      `&amp;&lt;&gt;&quot;&#39;|&<>"'||`,
    );
  });

  test("preserves whitespace and removes comments", () => {
    expect(render(" a \n{{! ignored }}\t b ", {})).toBe(" a \n\t b ");
  });

  test("handles if truthiness, else, and nesting", () => {
    const template = "{{#if list}}Y{{#if zero}}bad{{else}}N{{/if}}{{else}}E{{/if}}";
    expect(render(template, { list: [1], zero: 0 })).toBe("YN");
    expect(render(template, { list: [], zero: 1 })).toBe("E");
    expect(render("{{#if value}}yes{{else}}no{{/if}}", { value: 0n })).toBe("no");
  });

  test("allows numeric and punctuation-bearing JSON path segments", () => {
    expect(render("{{items.0.first-name}}", { items: [{ "first-name": "Ada" }] })).toBe(
      "Ada",
    );
  });

  test("iterates nested arrays with this, index, local values, and root fallback", () => {
    const template =
      "{{#each groups}}[{{name}}/{{title}}:{{#each this.items}}{{@index}}={{this}};{{else}}empty{{/each}}]{{else}}none{{/each}}";
    expect(
      render(template, {
        title: "root",
        groups: [
          { name: "A", items: ["x", "y"] },
          { name: "B", items: [] },
        ],
      }),
    ).toBe("[A/root:0=x;1=y;][B/root:empty]");
    expect(render("{{#each items}}x{{else}}none{{/each}}", { items: null })).toBe(
      "none",
    );
  });

  test("rejects non-scalar interpolation", () => {
    expect(() => render("value={{value}}", { value: { nested: true } })).toThrow(
      /line 1, column 7.*cannot be rendered as scalar text/,
    );
  });

  test.each([
    ["{{#wat x}}{{/wat}}", /Unknown block.*line 1, column 1|line 1, column 1.*Unknown block/],
    ["{{/if}}", /line 1, column 1.*Unexpected closing/],
    ["{{#if x}}\n{{/each}}", /line 2, column 1.*Mismatched/],
    ["{{#if x}}{{else}}{{else}}{{/if}}", /line 1, column 18.*Duplicate else/],
    ["x\n {{else}}", /line 2, column 2.*outside a block/],
    ["{{#each x}}", /line 1, column 1.*Unclosed each/],
  ])("reports structural error for %s", (template, pattern) => {
    expect(() => render(template, {})).toThrow(pattern as RegExp);
  });
});
