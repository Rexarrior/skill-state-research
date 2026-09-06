import { describe, expect, test } from "bun:test";
import { render } from "../src/engine";

describe("render", () => {
  test("interpolates escaped and raw values and preserves whitespace", () => {
    expect(render(" A {{value}} / {{{value}}}\n", { value: `<&>\"'` }))
      .toBe(" A &lt;&amp;&gt;&quot;&#39; / <&>\"'\n");
  });

  test("renders missing values as empty strings", () => {
    expect(render("x{{missing.deep}}y", {})).toBe("xy");
  });

  test("supports nested conditionals and specified truthiness", () => {
    expect(render("{{#if a}}A{{#if b}}B{{else}}C{{/if}}{{else}}D{{/if}}", { a: [1], b: 0 })).toBe("AC");
    for (const value of ["", 0, false, null, undefined, []]) {
      expect(render("{{#if value}}yes{{else}}no{{/if}}", { value })).toBe("no");
    }
    expect(render("{{#if value}}yes{{/if}}", { value: {} })).toBe("yes");
  });

  test("iterates nested arrays with local values, indexes, and root fallback", () => {
    const template = "{{#each groups}}[{{name}}/{{title}}:{{#each items}}{{@index}}={{this}},{{else}}empty{{/each}}]{{/each}}";
    expect(render(template, {
      title: "root",
      groups: [{ name: "A", items: ["x", "y"] }, { name: "B", items: [] }],
    })).toBe("[A/root:0=x,1=y,][B/root:empty]");
  });

  test("comments emit nothing", () => {
    expect(render("before{{! hidden }}after", {})).toBe("beforeafter");
  });

  test("rejects non-scalar interpolation", () => {
    expect(() => render("line\n{{value}}", { value: {} })).toThrow("Cannot render an object as scalar text at line 2, column 1");
    expect(() => render("{{this}}", () => 1)).toThrow("Cannot render a function as scalar text");
  });

  test("reports structural errors with line and column", () => {
    const cases: Array<[string, string]> = [
      ["x\n{{#wat x}}", "Unknown block \"wat\" at line 2, column 1"],
      ["{{#if x}}{{/each}}", "Mismatched closing block"],
      ["{{#if x}}", "Unclosed if block"],
      ["{{else}}", "Unexpected else outside a block"],
      ["{{#if x}}{{else}}{{else}}{{/if}}", "Duplicate else"],
      ["{{/if}}", "Unexpected closing block"],
    ];
    for (const [template, message] of cases) expect(() => render(template, {})).toThrow(message);
  });
});
