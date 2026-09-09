import { describe, expect, test } from "bun:test";
import { render, TemplateError } from "../src/engine";

describe("render", () => {
  test("interpolates escaped and raw scalar values", () => {
    const data = { value: `&<>"'`, zero: 0, no: false, missing: undefined };
    expect(render("{{value}}|{{{value}}}|{{zero}}|{{no}}|{{missing}}", data))
      .toBe("&amp;&lt;&gt;&quot;&#39;|&<>\"'|0|false|");
  });

  test("preserves whitespace and removes comments", () => {
    expect(render("  a\n{{! ignored }}\n b  ", {})).toBe("  a\n\n b  ");
  });

  test("supports nested if blocks and specified truthiness", () => {
    expect(render("{{#if a}}A{{#if b}}B{{else}}C{{/if}}{{else}}D{{/if}}", { a: true, b: 0 })).toBe("AC");
    for (const value of ["", 0, false, null, undefined, []]) {
      expect(render("{{#if value}}yes{{else}}no{{/if}}", { value })).toBe("no");
    }
    expect(render("{{#if value}}yes{{else}}no{{/if}}", { value: {} })).toBe("yes");
  });

  test("iterates nested arrays with local paths, indices, and root fallback", () => {
    const template = "{{#each groups}}[{{@index}}:{{name}}/{{title}} {{#each items}}({{@index}}={{this}}/{{title}}){{else}}empty{{/each}}]{{else}}none{{/each}}";
    const data = { title: "ROOT", groups: [{ name: "one", items: ["a", "b"] }, { name: "two", items: [] }] };
    expect(render(template, data)).toBe("[0:one/ROOT (0=a/ROOT)(1=b/ROOT)][1:two/ROOT empty]");
    expect(render("{{#each values}}{{this.name}}{{/each}}", { values: [{ name: "A" }] })).toBe("A");
  });

  test("uses each alternate for missing, non-array, and empty values", () => {
    expect(render("{{#each x}}item{{else}}empty{{/each}}", { x: [] })).toBe("empty");
    expect(render("{{#each x}}item{{else}}empty{{/each}}", { x: "no" })).toBe("empty");
  });

  test("rejects non-scalar interpolations", () => {
    expect(() => render("before {{x}}", { x: {} })).toThrow(/Cannot render object value.*line 1, column 8/);
    expect(() => render("{{x}}", { x: () => 1 })).toThrow(/Cannot render function value/);
  });

  test.each([
    ["{{#wat x}}{{/wat}}", /Unknown block.*line 1, column 1/],
    ["x\n{{else}}", /else outside.*line 2, column 1/],
    ["{{#if x}}{{else}}{{else}}{{/if}}", /Duplicate else.*column 18/],
    ["{{#if x}}{{/each}}", /Mismatched closing block.*column 10/],
    ["{{/if}}", /without an open block.*column 1/],
    ["{{#each x}}", /Unclosed each block.*column 1/],
    ["hello {{name", /Unclosed tag.*column 7/],
  ])("reports structural error for %s", (template, pattern) => {
    expect(() => render(template, { x: true })).toThrow(pattern);
  });

  test("exports a recognizable template error", () => {
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
