import { describe, expect, test } from "bun:test";
import { render } from "./engine";

describe("render", () => {
  test("escapes interpolations and supports raw values", () => {
    expect(render(`{{value}}|{{{value}}}`, { value: `&<>"'` })).toBe("&amp;&lt;&gt;&quot;&#39;|&<>\"'");
  });

  test("preserves whitespace and removes comments", () => {
    expect(render(" a \n{{! ignored }} b ", {})).toBe(" a \n b ");
  });

  test("handles nested conditionals and specified false values", () => {
    expect(render("{{#if a}}A{{#if b}}B{{else}}C{{/if}}{{else}}D{{/if}}", { a: [], b: true })).toBe("D");
    for (const value of ["", 0, false, null, undefined, []]) {
      expect(render("{{#if value}}yes{{else}}no{{/if}}", { value })).toBe("no");
    }
    expect(render("{{#if value}}yes{{else}}no{{/if}}", { value: {} })).toBe("yes");
  });

  test("iterates nested arrays with local values, indexes, and root fallback", () => {
    const template = "{{#each groups}}[{{name}}/{{title}}:{{#each items}}{{@index}}={{this}};{{else}}empty{{/each}}]{{/each}}";
    expect(render(template, {
      title: "root",
      groups: [{ name: "a", items: ["x", "y"] }, { name: "b", items: [] }],
    })).toBe("[a/root:0=x;1=y;][b/root:empty]");
  });

  test("renders missing values as empty strings and rejects nonscalars", () => {
    expect(render("x{{missing}}y", {})).toBe("xy");
    expect(() => render("{{value}}", { value: {} })).toThrow("cannot be rendered as scalar text");
    expect(() => render("{{value}}", { value: () => 1 })).toThrow("cannot be rendered as scalar text");
  });

  test("reports structural errors with line and column", () => {
    expect(() => render("line\n{{else}}", {})).toThrow("line 2, column 1");
    expect(() => render("{{#if x}}{{else}}{{else}}{{/if}}", {})).toThrow("Duplicate else");
    expect(() => render("{{#if x}}{{/each}}", {})).toThrow("Mismatched closing block");
    expect(() => render("{{#wat x}}{{/wat}}", {})).toThrow("Unknown block wat");
    expect(() => render("{{#each x}}", {})).toThrow("Unclosed each block");
  });
});
