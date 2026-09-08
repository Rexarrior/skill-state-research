import { describe, expect, test } from "bun:test";
import { render } from "./engine";

describe("render", () => {
  test("interpolates escaped and raw scalar values", () => {
    const value = `<a title="x">Tom & 'Jo'</a>`;
    expect(render("{{value}}|{{{value}}}", { value })).toBe(
      "&lt;a title=&quot;x&quot;&gt;Tom &amp; &#39;Jo&#39;&lt;/a&gt;|" + value,
    );
    expect(render("x{{missing}}y", {})).toBe("xy");
  });

  test("supports nested conditionals and specified truthiness", () => {
    const template = "{{#if a}}A{{#if b}}B{{else}}C{{/if}}{{else}}D{{/if}}";
    expect(render(template, { a: true, b: 0 })).toBe("AC");
    expect(render(template, { a: [], b: true })).toBe("D");
    expect(render("{{#if value}}yes{{else}}no{{/if}}", { value: {} })).toBe("yes");
  });

  test("iterates arrays with local values, indexes, root fallback, and nesting", () => {
    const template = "{{#each groups}}[{{name}}:{{#each items}}{{@index}}={{this}}/{{title}};{{else}}empty{{/each}}]{{else}}none{{/each}}";
    expect(render(template, {
      title: "root",
      groups: [{ name: "a", items: ["x", "y"] }, { name: "b", items: [] }],
    })).toBe("[a:0=x/root;1=y/root;][b:empty]");
    expect(render("{{#each items}}x{{else}}empty{{/each}}", { items: "no" })).toBe("empty");
  });

  test("preserves whitespace and removes comments", () => {
    expect(render(" a\n{{! ignored }}\n b ", {})).toBe(" a\n\n b ");
  });

  test("rejects structural mistakes with locations", () => {
    for (const template of [
      "x\n{{else}}",
      "{{#if x}}{{else}}{{else}}{{/if}}",
      "{{#each x}}{{/if}}",
      "{{#wat x}}{{/wat}}",
      "{{#if x}}",
    ]) {
      expect(() => render(template, {})).toThrow(/line \d+, column \d+/);
    }
  });

  test("rejects non-scalar interpolation", () => {
    expect(() => render("{{value}}", { value: { x: 1 } })).toThrow(/cannot be rendered/);
    expect(() => render("{{value}}", { value: [1] })).toThrow(/cannot be rendered/);
  });
});
