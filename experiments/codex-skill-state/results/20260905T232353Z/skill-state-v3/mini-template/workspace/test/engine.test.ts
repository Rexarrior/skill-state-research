import { describe, expect, test } from "bun:test";
import { render } from "../src/engine";

describe("render", () => {
  test("interpolates dotted paths with HTML escaping", () => {
    expect(render(`Hello {{user.name}}: {{user.html}}`, {
      user: { name: "Ada", html: `<a title="x">Tom & 'Ada'</a>` },
    })).toBe(`Hello Ada: &lt;a title=&quot;x&quot;&gt;Tom &amp; &#39;Ada&#39;&lt;/a&gt;`);
  });

  test("supports raw values, comments, missing values, and exact whitespace", () => {
    expect(render(" A {{! hidden }} {{{html}}} /{{missing}}/\n", { html: "<b>x</b>" }))
      .toBe(" A  <b>x</b> //\n");
  });

  test("renders nested conditions and specified false values", () => {
    const template = "{{#if ok}}Y{{#if empty}}bad{{else}}N{{/if}}{{else}}bad{{/if}}";
    expect(render(template, { ok: [], empty: true })).toBe("bad");
    expect(render(template, { ok: 1, empty: "" })).toBe("YN");
  });

  test("iterates arrays with loop locals and root fallback", () => {
    const template = "{{#each groups}}[{{@index}}:{{this.name}}/{{title}}" +
      "{{#each this.items}}({{@index}}={{this}}/{{title}}){{else}}empty{{/each}}]" +
      "{{else}}none{{/each}}";
    expect(render(template, {
      title: "root",
      groups: [{ name: "a", items: ["x", "y"] }, { name: "b", items: [] }],
    })).toBe("[0:a/root(0=x/root)(1=y/root)][1:b/rootempty]");
    expect(render("{{#each items}}x{{else}}none{{/each}}", { items: "not-array" })).toBe("none");
  });

  test("rejects structural errors with line and column", () => {
    expect(() => render("x\n {{else}}", {})).toThrow("else outside a block at line 2, column 2");
    expect(() => render("{{#if x}}{{else}}{{else}}{{/if}}", {})).toThrow("Duplicate else");
    expect(() => render("{{#if x}}{{/each}}", {})).toThrow("Mismatched closing block");
    expect(() => render("{{#wat x}}", {})).toThrow('Unknown block "wat"');
    expect(() => render("{{#each x}}", {})).toThrow("Unclosed block #each");
    expect(() => render("hello {{name", {})).toThrow("Unclosed tag");
  });

  test("rejects non-scalar interpolation values", () => {
    expect(() => render("line\n{{user}}", { user: { name: "Ada" } }))
      .toThrow('Value at "user" is not scalar text at line 2, column 1');
    expect(() => render("{{value}}", { value: () => 1 })).toThrow("not scalar text");
  });
});
