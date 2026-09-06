import { describe, expect, test } from "bun:test";
import { render, TemplateError } from "../src/engine";

describe("render", () => {
  test("escapes interpolation and leaves triple braces raw", () => {
    const data = { value: `&<>"'` };
    expect(render("{{value}}|{{{value}}}", data)).toBe("&amp;&lt;&gt;&quot;&#39;|&<>\"'");
  });

  test("preserves whitespace, removes comments, and empties missing values", () => {
    expect(render(" a \n{{! ignored }} {{missing}} z ", {})).toBe(" a \n  z ");
  });

  test("supports nested conditionals and specified truthiness", () => {
    expect(render("{{#if ok}}A{{#if empty}}X{{else}}B{{/if}}{{else}}C{{/if}}", { ok: [], empty: true })).toBe("C");
    expect(render("{{#if value}}yes{{else}}no{{/if}}", { value: {} })).toBe("yes");
    for (const value of ["", 0, false, null, undefined, []]) {
      expect(render("{{#if value}}yes{{else}}no{{/if}}", { value })).toBe("no");
    }
  });

  test("iterates arrays with this, index, root fallback, nesting, and else", () => {
    const template = "{{#each rows}}[{{@index}}:{{this.name}}/{{title}}:{{#each this.values}}{{@index}}={{this}};{{else}}none{{/each}}]{{else}}empty{{/each}}";
    expect(render(template, { title: "T", rows: [{ name: "a", values: [1, 2] }, { name: "b", values: [] }] }))
      .toBe("[0:a/T:0=1;1=2;][1:b/T:none]");
    expect(render("{{#each rows}}x{{else}}empty{{/each}}", { rows: "not-array" })).toBe("empty");
  });

  test("rejects non-scalar interpolation", () => {
    expect(() => render("line\n{{value}}", { value: {} })).toThrow("Value at \"value\" is not scalar text at line 2, column 1");
  });

  test("reports structural errors with line and column", () => {
    const cases = [
      ["x\n{{else}}", "Unexpected else outside a block at line 2, column 1"],
      ["{{#if x}}{{else}}{{else}}{{/if}}", "Duplicate else at line 1, column 18"],
      ["{{#if x}}{{/each}}", "Mismatched closing block"],
      ["{{#wat x}}{{/wat}}", "Unknown or malformed block \"wat\""],
      ["{{#each x}}", "Unclosed \"each\" block at line 1, column 1"],
    ] as const;
    for (const [template, message] of cases) {
      expect(() => render(template, { x: true })).toThrow(message);
    }
  });

  test("exports a specific error type", () => {
    expect(() => render("{{/if}}", {})).toThrow(TemplateError);
  });
});
