import { describe, expect, test } from "bun:test";
import { render, TemplateError } from "../src/engine";

describe("render", () => {
  test("interpolates escaped, raw, and missing values", () => {
    const data = { value: `&<>\"'`, raw: "<b>ok</b>" };
    expect(render("{{value}} {{{raw}}} [{{missing}}]", data)).toBe(
      "&amp;&lt;&gt;&quot;&#39; <b>ok</b> []",
    );
  });

  test("preserves whitespace and removes comments", () => {
    expect(render(" a\n {{! ignored }} \t b ", {})).toBe(" a\n  \t b ");
  });

  test("supports nested conditions and specified truthiness", () => {
    expect(render("{{#if a}}A{{#if b}}B{{else}}C{{/if}}{{else}}D{{/if}}", { a: 1, b: 0 })).toBe("AC");
    for (const value of ["", 0, false, null, undefined, []]) {
      expect(render("{{#if value}}yes{{else}}no{{/if}}", { value })).toBe("no");
    }
    expect(render("{{#if value}}yes{{else}}no{{/if}}", { value: {} })).toBe("yes");
  });

  test("iterates arrays with this, index, root fallback, nesting, and else", () => {
    const template = "{{#each rows}}{{title}}:{{@index}}={{name}}/{{this.name}}[{{#each this.values}}{{@index}}/{{this}}/{{title}};{{/each}}]{{else}}empty{{/each}}";
    expect(render(template, { title: "T", rows: [{ name: "a", values: [2, 3] }] })).toBe(
      "T:0=a/a[0/2/T;1/3/T;]",
    );
    expect(render("{{#each rows}}x{{else}}empty{{/each}}", { rows: [] })).toBe("empty");
  });

  test("rejects non-scalar interpolation", () => {
    expect(() => render("at {{item}}", { item: {} })).toThrow(/not scalar text.*line 1, column 4/u);
    expect(() => render("{{this}}", () => 1)).toThrow(/not scalar text/u);
  });

  test.each([
    ["{{#wat x}}{{/wat}}", /Unknown block.*line 1, column 1/u],
    ["x\n{{else}}", /else outside.*line 2, column 1/u],
    ["{{#if x}}{{else}}{{else}}{{/if}}", /Duplicate else/u],
    ["{{#if x}}{{/each}}", /Mismatched closing block/u],
    ["{{/if}}", /without an open block/u],
    ["{{#if x}}", /Unclosed "if" block/u],
    ["{{value", /Unclosed template tag/u],
  ])("reports structural error for %s", (template, pattern) => {
    expect(() => render(template, {})).toThrow(pattern);
  });

  test("exports errors with locations", () => {
    try {
      render("\n{{else}}", {});
      throw new Error("expected an error");
    } catch (error) {
      expect(error).toBeInstanceOf(TemplateError);
      expect((error as TemplateError).line).toBe(2);
      expect((error as TemplateError).column).toBe(1);
    }
  });
});
