import { describe, expect, test } from "bun:test";
import { render } from "../src/engine";

describe("render", () => {
  test("escapes interpolation and preserves raw interpolation", () => {
    const value = `&<>"'`;
    expect(render("{{value}}|{{{value}}}", { value })).toBe("&amp;&lt;&gt;&quot;&#39;|&<>\"'");
  });

  test("renders missing values as empty strings and preserves whitespace", () => {
    expect(render(" a\n {{ missing }} \n", {})).toBe(" a\n  \n");
  });

  test("handles if truthiness, else, and nesting", () => {
    const template = "{{#if show}}A{{#if empty}}X{{else}}B{{/if}}{{else}}C{{/if}}";
    expect(render(template, { show: 1, empty: [] })).toBe("AB");
    expect(render(template, { show: 0, empty: [1] })).toBe("C");
  });

  test("iterates arrays with locals, indexes, root fallback, and nested loops", () => {
    const template = "{{#each groups}}[{{name}}/{{title}}:{{#each items}}{{@index}}={{this}};{{else}}none{{/each}}]{{else}}empty{{/each}}";
    expect(render(template, {
      title: "root",
      groups: [{ name: "one", items: ["a", "b"] }, { name: "two", items: [] }],
    })).toBe("[one/root:0=a;1=b;][two/root:none]");
    expect(render(template, { title: "root", groups: [] })).toBe("empty");
  });

  test("comments emit nothing", () => {
    expect(render("a{{! hidden }}b", {})).toBe("ab");
  });

  test("rejects non-scalar interpolation", () => {
    expect(() => render("{{thing}}", { thing: {} })).toThrow("not scalar text");
  });

  test("reports structural errors with line and column", () => {
    expect(() => render("first\n{{else}}", {})).toThrow("else outside a block at line 2, column 1");
    expect(() => render("{{#if x}}{{else}}{{else}}{{/if}}", {})).toThrow("Duplicate else");
    expect(() => render("{{#if x}}{{/each}}", {})).toThrow("Mismatched closing block");
    expect(() => render("x{{#wat y}}", {})).toThrow("Unknown or malformed block");
    expect(() => render("x{{#each y}}", {})).toThrow("Unclosed #each block");
  });
});
