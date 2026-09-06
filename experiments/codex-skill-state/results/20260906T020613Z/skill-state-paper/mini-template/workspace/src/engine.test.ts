import { describe, expect, test } from "bun:test";
import { render } from "./engine";

describe("render", () => {
  test("escapes interpolations and preserves raw interpolations", () => {
    const data = { value: `&<>"'` };
    expect(render("{{value}} / {{{value}}}", data)).toBe("&amp;&lt;&gt;&quot;&#39; / &<>\"'");
  });

  test("renders missing values as empty strings", () => {
    expect(render("a{{missing.deep}}b", {})).toBe("ab");
  });

  test("supports nested conditionals and exact false rules", () => {
    expect(render("{{#if list}}yes{{#if zero}}bad{{else}}!{{/if}}{{else}}no{{/if}}", { list: [1], zero: 0 })).toBe("yes!");
    expect(render("{{#if list}}yes{{else}}no{{/if}}", { list: [] })).toBe("no");
  });

  test("iterates arrays with this, index, root fallback, and nesting", () => {
    const template = "{{#each groups}}[{{@index}}:{{this.name}}/{{title}}:{{#each this.items}}{{@index}}={{this}};{{else}}empty{{/each}}]{{/each}}";
    expect(render(template, {
      title: "T",
      groups: [{ name: "A", items: ["x", "y"] }, { name: "B", items: [] }],
    })).toBe("[0:A/T:0=x;1=y;][1:B/T:empty]");
  });

  test("removes comments while retaining surrounding whitespace", () => {
    expect(render(" a \n{{! ignore me }}\n b ", {})).toBe(" a \n\n b ");
  });

  test("rejects non-scalar interpolation", () => {
    expect(() => render("{{user}}", { user: { name: "Ada" } })).toThrow("cannot be rendered as scalar text");
  });

  test("reports structural errors with line and column", () => {
    expect(() => render("one\n{{else}}", {})).toThrow("line 2, column 1");
    expect(() => render("{{#if ok}}{{else}}{{else}}{{/if}}", { ok: true })).toThrow("Duplicate 'else'");
    expect(() => render("{{#if ok}}{{/each}}", { ok: true })).toThrow("Mismatched closing block");
    expect(() => render("x {{#wat ok}}", {})).toThrow("Unknown or malformed block");
    expect(() => render("{{#each xs}}", { xs: [] })).toThrow("Unclosed 'each' block");
  });
});
