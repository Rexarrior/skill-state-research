import { describe, expect, test } from "bun:test";
import { render } from "../src/engine";

describe("render", () => {
  test("interpolates and escapes HTML", () => {
    expect(render("Hello {{user.name}}!", { user: { name: '<Ada & "Bob"\'' } })).toBe("Hello &lt;Ada &amp; &quot;Bob&quot;&#39;!");
    expect(render("{{{value}}}", { value: "<b>ok</b>" })).toBe("<b>ok</b>");
  });

  test("preserves whitespace and ignores comments", () => {
    expect(render(" a\n{{! note }} b ", {})).toBe(" a\n b ");
  });

  test("handles if values and nesting", () => {
    expect(render("{{#if active}}yes{{#if name}} {{name}}{{/if}}{{else}}no{{/if}}", { active: true, name: "Ada" })).toBe("yes Ada");
    expect(render("{{#if list}}yes{{else}}no{{/if}}", { list: [] })).toBe("no");
  });

  test("handles loops, root fallback, nested loops and else", () => {
    const template = "{{#each groups}}{{title}}:{{#each this}}[{{@index}}={{this}}/{{title}}]{{/each}};{{else}}none{{/each}}";
    expect(render(template, { title: "root", groups: [["a", "b"], ["c"]] })).toBe("root:[0=a/root][1=b/root];root:[0=c/root];");
    expect(render("{{#each items}}x{{else}}empty{{/each}}", { items: [] })).toBe("empty");
  });

  test("renders missing values empty and rejects non-scalars", () => {
    expect(render("x{{missing}}y", {})).toBe("xy");
    expect(() => render("{{value}}", { value: {} })).toThrow("Cannot render object");
  });

  test("reports structural errors with locations", () => {
    for (const source of ["{{#wat x}}", "{{/if}}", "{{else}}", "{{#if x}}{{else}}{{else}}{{/if}}", "{{#if x}}", "{{#if x}}{{/each}}"])
      expect(() => render(source, {})).toThrow(/line 1, column/);
  });
});
