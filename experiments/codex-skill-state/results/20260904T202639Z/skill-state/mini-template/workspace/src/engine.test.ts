import { describe, expect, test } from "bun:test";
import { render } from "./engine.ts";

describe("render", () => {
  test("escapes interpolation and preserves raw interpolation", () => {
    const value = `&<>"'`;
    expect(render("{{value}}|{{{value}}}", { value })).toBe(
      "&amp;&lt;&gt;&quot;&#39;|&<>\"'",
    );
  });

  test("resolves nested and missing values", () => {
    expect(render("Hello {{user.name}}/{{missing}}!", { user: { name: "Ada" } })).toBe(
      "Hello Ada/!",
    );
  });

  test("supports nested if blocks, else, comments, and specified truthiness", () => {
    const template = "{{! x }}{{#if ok}}A{{#if items}}B{{else}}C{{/if}}{{else}}D{{/if}}";
    expect(render(template, { ok: true, items: [] })).toBe("AC");
    expect(render(template, { ok: 0, items: [1] })).toBe("D");
  });

  test("iterates nested arrays with this, index, local paths, and root fallback", () => {
    const template =
      "{{#each groups}}[{{name}}/{{title}}:{{#each values}}{{@index}}={{this}};{{else}}empty{{/each}}]{{else}}none{{/each}}";
    expect(
      render(template, {
        title: "root",
        groups: [
          { name: "a", values: ["x", "y"] },
          { name: "b", values: [] },
        ],
      }),
    ).toBe("[a/root:0=x;1=y;][b/root:empty]");
    expect(render("{{#each rows}}x{{else}}none{{/each}}", { rows: [] })).toBe("none");
  });

  test("preserves whitespace exactly", () => {
    expect(render(" a\n  {{value}} \n", { value: "b" })).toBe(" a\n  b \n");
  });

  test("rejects non-scalar interpolation", () => {
    expect(() => render("x {{value}}", { value: { x: 1 } })).toThrow(
      /not scalar text.*line 1, column 3/,
    );
  });

  test("reports structural mistakes with locations", () => {
    expect(() => render("one\n{{#wat x}}", {})).toThrow(/Unknown block 'wat'.*line 2, column 1/);
    expect(() => render("{{#if x}}{{/each}}", {})).toThrow(/Mismatched.*line 1, column 10/);
    expect(() => render("{{#if x}}", {})).toThrow(/Unclosed block 'if'.*line 1, column 1/);
    expect(() => render("{{else}}", {})).toThrow(/outside a block.*line 1, column 1/);
    expect(() => render("{{#if x}}{{else}}{{else}}{{/if}}", {})).toThrow(
      /Duplicate 'else'.*line 1, column 18/,
    );
  });
});
