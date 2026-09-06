import { describe, expect, test } from "bun:test";
import { render } from "./engine.ts";

describe("render", () => {
  test("preserves text and escapes interpolated values", () => {
    expect(render("Hello, {{name}}!", { name: '<Ada & "Bob"\'' })).toBe("Hello, &lt;Ada &amp; &quot;Bob&quot;&#39;!");
    expect(render("{{{name}}}", { name: "<b>Ada</b>" })).toBe("<b>Ada</b>");
  });

  test("handles nested conditionals and template truthiness", () => {
    expect(render("{{#if user}}{{#if user.active}}yes{{else}}no{{/if}}{{else}}none{{/if}}", { user: { active: false } })).toBe("no");
    expect(render("{{#if items}}shown{{else}}empty{{/if}}", { items: [] })).toBe("empty");
  });

  test("iterates with this, index, root fallbacks, and nested loops", () => {
    const template = "{{#each groups}}{{title}}:{{#each this.items}}[{{@index}}={{this}}/{{title}}]{{else}}none{{/each}};{{/each}}";
    expect(render(template, { title: "Root", groups: [{ items: ["x", "y"] }, { items: [] }] }))
      .toBe("Root:[0=x/Root][1=y/Root];Root:none;");
  });

  test("supports each else, missing values, comments, and exact whitespace", () => {
    expect(render("a {{! ignored }} {{missing}}\n{{#each rows}}x{{else}}none{{/each}}", { rows: [] })).toBe("a  \nnone");
  });

  test("reports structural and scalar errors with locations", () => {
    expect(() => render("x\n{{#if ok}}", { ok: true })).toThrow("line 2, column 1");
    expect(() => render("{{#if ok}}{{/each}}", { ok: true })).toThrow("mismatched closing");
    expect(() => render("{{value}}", { value: {} })).toThrow("cannot render an object");
  });
});
