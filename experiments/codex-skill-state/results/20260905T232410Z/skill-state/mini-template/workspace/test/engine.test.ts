import { describe, expect, test } from "bun:test";
import { render } from "../src/engine";

describe("render", () => {
  test("escapes values and preserves raw values", () => {
    const value = `&<>"'`;
    expect(render("{{value}}|{{{value}}}", { value })).toBe("&amp;&lt;&gt;&quot;&#39;|&<>\"'");
  });

  test("renders missing and primitive values", () => {
    expect(render("{{missing}} {{zero}} {{no}}", { zero: 0, no: false })).toBe(" 0 false");
  });

  test("supports nested conditionals and specified truthiness", () => {
    expect(render("{{#if a}}A{{#if b}}B{{else}}C{{/if}}{{else}}D{{/if}}", { a: true, b: 0 })).toBe("AC");
    for (const value of ["", 0, false, null, undefined, []]) {
      expect(render("{{#if x}}yes{{else}}no{{/if}}", { x: value })).toBe("no");
    }
    expect(render("{{#if x}}yes{{/if}}", { x: {} })).toBe("yes");
  });

  test("supports loops, root fallback, and nested loops", () => {
    const template = "{{#each groups}}[{{@index}}:{{name}}/{{title}}:{{#each values}}{{@index}}={{this}};{{else}}empty{{/each}}]{{else}}none{{/each}}";
    expect(render(template, { title: "T", groups: [{ name: "A", values: [1, 2] }, { name: "B", values: [] }] }))
      .toBe("[0:A/T:0=1;1=2;][1:B/T:empty]");
    expect(render("{{#each rows}}x{{else}}empty{{/each}}", { rows: [] })).toBe("empty");
  });

  test("removes comments while preserving other whitespace", () => {
    expect(render(" a \n{{! ignored }}\n b ", {})).toBe(" a \n\n b ");
  });

  test("rejects non-scalars", () => {
    expect(() => render("{{user}}", { user: {} })).toThrow(/cannot be rendered.*line 1, column 1/);
  });

  test("reports structural errors with locations", () => {
    const cases = [
      ["x\n{{#wat x}}", /Unknown block.*line 2, column 1/],
      ["{{#if x}}{{/each}}", /Mismatched.*line 1, column 10/],
      ["{{#if x}}", /Unclosed block.*line 1, column 1/],
      ["{{#if x}}{{else}}{{else}}{{/if}}", /Duplicate.*line 1, column 18/],
      ["a{{else}}", /outside.*line 1, column 2/],
    ] as const;
    for (const [template, pattern] of cases) expect(() => render(template, {})).toThrow(pattern);
  });
});
