import { describe, expect, test } from "bun:test";
import { render, TemplateError } from "../src/engine";

describe("render", () => {
  test("interpolates escaped, raw, and missing values", () => {
    expect(render("{{x}}|{{{x}}}|{{missing}}", { x: `&<>"'` }))
      .toBe("&amp;&lt;&gt;&quot;&#39;|&<>\"'|");
  });

  test("preserves whitespace and removes comments", () => {
    expect(render(" a \n{{! ignored }}\n b ", {})).toBe(" a \n\n b ");
  });

  test("handles if truthiness and nested branches", () => {
    const template = "{{#if value}}yes{{#if nested}}!{{else}}?{{/if}}{{else}}no{{/if}}";
    expect(render(template, { value: [], nested: true })).toBe("no");
    expect(render(template, { value: [1], nested: false })).toBe("yes?");
    for (const value of ["", 0, false, null, undefined, []]) {
      expect(render("{{#if x}}T{{else}}F{{/if}}", { x: value })).toBe("F");
    }
  });

  test("iterates with item paths, this, index, root fallback, and nesting", () => {
    const template = "{{#each groups}}[{{name}}/{{title}}:{{#each this.items}}({{@index}}={{this}}/{{name}}/{{title}}){{else}}empty{{/each}}]{{else}}none{{/each}}";
    expect(render(template, {
      title: "root",
      groups: [{ name: "A", items: ["x", "y"] }, { name: "B", items: [] }],
    })).toBe("[A/root:(0=x/A/root)(1=y/A/root)][B/root:empty]");
    expect(render("{{#each xs}}x{{else}}empty{{/each}}", { xs: "not-array" })).toBe("empty");
  });

  test("rejects non-scalar interpolation", () => {
    expect(() => render("{{x}}", { x: { nested: true } })).toThrow("not scalar text");
    expect(() => render("{{x}}", { x: [1] })).toThrow("not scalar text");
  });

  test("reports structural errors with line and column", () => {
    const invalid = [
      ["x\n{{else}}", "line 2, column 1"],
      ["{{#if x}}a{{else}}b{{else}}c{{/if}}", "Duplicate"],
      ["{{#if x}}{{/each}}", "Mismatched"],
      ["{{#wat x}}", "Unknown"],
      ["{{#each xs}}", "Unclosed"],
      ["{{/wat}}", "Unknown closing"],
    ];
    for (const [template, message] of invalid) {
      expect(() => render(template, {})).toThrow(message);
    }
    try {
      render("\n  {{else}}", {});
    } catch (error) {
      expect(error).toBeInstanceOf(TemplateError);
      expect((error as TemplateError).line).toBe(2);
      expect((error as TemplateError).column).toBe(3);
    }
  });
});
