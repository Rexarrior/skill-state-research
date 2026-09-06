import { describe, expect, test } from "bun:test";
import { render, TemplateError } from "../src/engine";

describe("render", () => {
  test("escapes values, supports raw values, missing values, and comments", () => {
    expect(render("{{x}}|{{{x}}}|{{missing}}{{! ignore }}", { x: `&<>\"'` }))
      .toBe("&amp;&lt;&gt;&quot;&#39;|&<>\"'|");
  });

  test("preserves whitespace exactly", () => {
    expect(render(" a\n  {{x}} \n", { x: "b" })).toBe(" a\n  b \n");
  });

  test("implements the specified truthiness", () => {
    for (const value of ["", 0, false, null, undefined, []]) {
      expect(render("{{#if x}}yes{{else}}no{{/if}}", { x: value })).toBe("no");
    }
    for (const value of ["0", {}, [0], true, 1]) {
      expect(render("{{#if x}}yes{{else}}no{{/if}}", { x: value })).toBe("yes");
    }
  });

  test("supports nested blocks, loop context, root fallback, and else", () => {
    const template = "{{#each groups}}[{{@index}}:{{name}}/{{title}}:{{#each this.items}}{{@index}}={{this}};{{else}}empty{{/each}}]{{else}}none{{/each}}";
    const data = { title: "T", groups: [{ name: "A", items: ["x", "y"] }, { name: "B", items: [] }] };
    expect(render(template, data)).toBe("[0:A/T:0=x;1=y;][1:B/T:empty]");
    expect(render("{{#each xs}}x{{else}}empty{{/each}}", { xs: [] })).toBe("empty");
  });

  test("rejects non-scalar interpolation values", () => {
    expect(() => render("value={{x}}", { x: {} })).toThrow("not scalar");
    expect(() => render("{{x}}", { x: () => 1 })).toThrow("not scalar");
  });

  test("reports structural errors with line and column", () => {
    const cases = [
      "x\n{{else}}",
      "{{#if x}}{{else}}{{else}}{{/if}}",
      "{{#if x}}{{/each}}",
      "{{#wat x}}{{/wat}}",
      "{{#each x}}",
      "{{/if}}",
    ];
    for (const template of cases) {
      expect(() => render(template, {})).toThrow(TemplateError);
      expect(() => render(template, {})).toThrow(/line \d+, column \d+/);
    }
  });
});
