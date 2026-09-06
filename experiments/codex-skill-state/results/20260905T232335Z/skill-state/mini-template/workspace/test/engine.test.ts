import { describe, expect, test } from "bun:test";
import { render, TemplateError } from "../src/engine";

describe("render", () => {
  test("interpolates, escapes, and preserves whitespace", () => {
    expect(render(" A {{name}} / {{{name}}}\n", { name: `<x a=\"'&\">` }))
      .toBe(" A &lt;x a=&quot;&#39;&amp;&quot;&gt; / <x a=\"'&\">\n");
    expect(render("{{missing}}", {})).toBe("");
  });

  test("renders if branches with the specified truthiness", () => {
    for (const value of ["", 0, false, null, undefined, []]) {
      expect(render("{{#if value}}yes{{else}}no{{/if}}", { value })).toBe("no");
    }
    for (const value of ["x", 1, true, {}, [0]]) {
      expect(render("{{#if value}}yes{{else}}no{{/if}}", { value })).toBe("yes");
    }
  });

  test("iterates nested arrays with local lookup and root fallback", () => {
    const template = "{{#each groups}}[{{name}}/{{title}}:{{#each values}}{{@index}}={{this}};{{else}}empty{{/each}}]{{/each}}";
    expect(render(template, {
      title: "root",
      groups: [{ name: "a", values: ["x", "y"] }, { name: "b", values: [] }],
    })).toBe("[a/root:0=x;1=y;][b/root:empty]");
  });

  test("supports comments and nested conditionals", () => {
    expect(render("x{{! discarded }}{{#if a}}A{{#if b}}B{{else}}C{{/if}}{{/if}}y", { a: true, b: false }))
      .toBe("xACy");
  });

  test("rejects non-scalar interpolation", () => {
    expect(() => render("{{value}}", { value: { x: 1 } })).toThrow("not scalar");
    expect(() => render("{{value}}", { value: [1] })).toThrow("not scalar");
  });

  test("reports structural errors with line and column", () => {
    const cases = [
      "{{#wat x}}{{/wat}}",
      "{{else}}",
      "{{#if x}}{{else}}{{else}}{{/if}}",
      "{{#if x}}\n{{/each}}",
      "{{#each x}}",
      "{{/if}}",
    ];
    for (const template of cases) {
      try {
        render(template, {});
        throw new Error("expected render to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(TemplateError);
        expect((error as Error).message).toMatch(/line \d+, column \d+/);
      }
    }
  });
});
