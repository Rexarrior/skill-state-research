import { describe, expect, test } from "bun:test";
import { render } from "../src/engine";

describe("render", () => {
  test("escapes interpolation and leaves triple interpolation raw", () => {
    const value = `&<>"'`;
    expect(render("{{value}}|{{{value}}}", { value })).toBe(
      `&amp;&lt;&gt;&quot;&#39;|&<>"'`,
    );
  });

  test("resolves nested values and renders missing values as empty", () => {
    expect(render("Hello {{user.name}}/{{user.missing}}", { user: { name: "Ada" } })).toBe(
      "Hello Ada/",
    );
  });

  test("supports nested conditionals and defined false values", () => {
    const template = "{{#if user}}A{{#if count}}B{{else}}C{{/if}}{{else}}D{{/if}}";
    expect(render(template, { user: true, count: 0 })).toBe("AC");
    expect(render(template, { user: false, count: 2 })).toBe("D");
  });

  test("uses the specified truthiness rules", () => {
    for (const value of ["", 0, false, null, undefined, []]) {
      expect(render("{{#if value}}yes{{else}}no{{/if}}", { value })).toBe("no");
    }
    for (const value of ["0", -1, {}, [0]]) {
      expect(render("{{#if value}}yes{{else}}no{{/if}}", { value })).toBe("yes");
    }
  });

  test("iterates arrays with this, index, root fallback, and nesting", () => {
    const template =
      "{{#each groups}}[{{name}}:{{#each items}}{{@index}}={{this}}/{{title}};{{else}}empty{{/each}}]{{else}}none{{/each}}";
    const data = {
      title: "T",
      groups: [
        { name: "a", items: ["x", "y"] },
        { name: "b", items: [] },
      ],
    };
    expect(render(template, data)).toBe("[a:0=x/T;1=y/T;][b:empty]");
    expect(render("{{#each items}}x{{else}}none{{/each}}", { items: [] })).toBe("none");
  });

  test("removes comments and preserves all other whitespace", () => {
    expect(render(" a \n{{! ignore me }}\n b ", {})).toBe(" a \n\n b ");
  });

  test("rejects non-scalar interpolation", () => {
    expect(() => render("{{value}}", { value: {} })).toThrow("Cannot render non-scalar");
    expect(() => render("{{value}}", { value: [1] })).toThrow("line 1, column 1");
  });

  test("reports structural errors with a line and column", () => {
    const invalid = [
      "{{else}}",
      "{{#if x}}a{{else}}b{{else}}c{{/if}}",
      "{{#if x}}{{/each}}",
      "{{#wat x}}{{/wat}}",
      "line one\n{{#each xs}}",
      "{{#if x}}",
      "{{/if}}",
    ];
    for (const template of invalid) {
      expect(() => render(template, {})).toThrow(/line \d+, column \d+/);
    }
  });
});
