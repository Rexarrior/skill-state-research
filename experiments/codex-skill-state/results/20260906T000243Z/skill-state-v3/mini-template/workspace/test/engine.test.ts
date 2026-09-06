import { describe, expect, test } from "bun:test";
import { render } from "../src/engine";

describe("render", () => {
  test("escapes interpolations and leaves triple braces raw", () => {
    const value = `<a title="x">Tom & 'Sue'</a>`;
    expect(render("{{value}}|{{{value}}}", { value })).toBe(
      "&lt;a title=&quot;x&quot;&gt;Tom &amp; &#39;Sue&#39;&lt;/a&gt;|" + value,
    );
  });

  test("renders missing values as empty strings and preserves whitespace", () => {
    expect(render(" a\n  {{missing}} z ", {})).toBe(" a\n   z ");
  });

  test("supports nested conditionals and specified truthiness", () => {
    const template = "{{#if outer}}A{{#if inner}}B{{else}}C{{/if}}{{else}}D{{/if}}";
    expect(render(template, { outer: true, inner: 0 })).toBe("AC");
    expect(render(template, { outer: [], inner: true })).toBe("D");
  });

  test("iterates arrays with context, root fallback, else, and nesting", () => {
    const template = "{{#each rows}}[{{@index}}:{{this.name}}/{{title}}:{{#each this.values}}{{@index}}={{this}};{{else}}none{{/each}}]{{else}}empty{{/each}}";
    expect(render(template, { title: "T", rows: [{ name: "a", values: [2, 3] }, { name: "b", values: [] }] })).toBe(
      "[0:a/T:0=2;1=3;][1:b/T:none]",
    );
    expect(render(template, { title: "T", rows: [] })).toBe("empty");
  });

  test("removes comments", () => {
    expect(render("a{{! ignore <this> }}b", {})).toBe("ab");
  });

  test("rejects structural errors with line and column", () => {
    expect(() => render("x\n {{#if ok}}x{{/each}}", { ok: true })).toThrow("line 2, column 13");
    expect(() => render("{{#wat x}}{{/wat}}", {})).toThrow("Unknown block");
    expect(() => render("{{else}}", {})).toThrow("else outside a block");
    expect(() => render("{{#if x}}{{else}}{{else}}{{/if}}", {})).toThrow("Duplicate else");
    expect(() => render("{{#each xs}}", { xs: [] })).toThrow("Unclosed block");
  });

  test("rejects non-scalar interpolation", () => {
    expect(() => render("hello {{user}}", { user: { name: "Ada" } })).toThrow(
      'Value at "user" is not scalar text at line 1, column 7',
    );
  });
});
