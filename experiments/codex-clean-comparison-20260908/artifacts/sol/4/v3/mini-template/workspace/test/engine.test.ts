import { describe, expect, test } from "bun:test";
import { render } from "../src/engine";

describe("render", () => {
  test("interpolates, escapes, preserves whitespace, and supports raw values", () => {
    expect(render(" A {{user.name}} / {{{html}}} Z\n", {
      user: { name: `<&>\"'` },
      html: "<b>raw</b>",
    })).toBe(" A &lt;&amp;&gt;&quot;&#39; / <b>raw</b> Z\n");
  });

  test("missing values are empty and comments disappear", () => {
    expect(render("x{{missing.deep}}y{{! ignored }}z", {})).toBe("xyz");
  });

  test("if implements the specified truthiness and nests", () => {
    for (const value of ["", 0, false, null, undefined, []]) {
      expect(render("{{#if value}}yes{{else}}no{{/if}}", { value })).toBe("no");
    }
    for (const value of ["x", 1, true, {}, [0]]) {
      expect(render("{{#if value}}yes{{else}}no{{/if}}", { value })).toBe("yes");
    }
    expect(render("{{#if a}}A{{#if b}}B{{else}}C{{/if}}{{/if}}", { a: true, b: false })).toBe("AC");
  });

  test("each supports this, index, root fallback, nesting, and else", () => {
    const template = "{{#each groups}}[{{@index}}:{{this.name}}/{{title}}:{{#each this.items}}({{@index}}={{this}}/{{title}}){{else}}empty{{/each}}]{{else}}none{{/each}}";
    expect(render(template, {
      title: "T",
      groups: [{ name: "a", items: ["x", "y"] }, { name: "b", items: [] }],
    })).toBe("[0:a/T:(0=x/T)(1=y/T)][1:b/T:empty]");
    expect(render("{{#each items}}{{this}}{{else}}empty{{/each}}", { items: [] })).toBe("empty");
    expect(render("{{#each missing}}x{{else}}empty{{/each}}", {})).toBe("empty");
  });

  test("rejects nonscalar values", () => {
    expect(() => render("{{value}}", { value: {} })).toThrow("cannot be rendered as scalar text");
    expect(() => render("{{value}}", { value: [1] })).toThrow("cannot be rendered as scalar text");
  });

  test("reports structural errors with line and column", () => {
    const bad = [
      "{{else}}",
      "{{#wat x}}x{{/wat}}",
      "{{#if x}}{{else}}{{else}}{{/if}}",
      "{{#if x}}{{/each}}",
      "line\n{{#if x}}",
      "{{/if}}",
    ];
    for (const template of bad) {
      expect(() => render(template, {})).toThrow(/line \d+, column \d+/);
    }
    expect(() => render("x\n  {{#if ok}}{{/each}}", { ok: true })).toThrow("line 2, column 13");
  });
});
