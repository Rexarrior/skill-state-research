import { describe, expect, test } from "bun:test";
import { render } from "../src/engine";

describe("render", () => {
  test("escapes interpolation and preserves raw interpolation", () => {
    const value = `&<>"'`;
    expect(render("{{value}}|{{{value}}}", { value })).toBe("&amp;&lt;&gt;&quot;&#39;|&<>\"'");
  });

  test("renders missing values as empty strings and preserves whitespace", () => {
    expect(render(" a\n {{missing}} \n", {})).toBe(" a\n  \n");
  });

  test("supports nested conditionals and custom truthiness", () => {
    expect(render("{{#if list}}Y{{#if no}}bad{{else}}!{{/if}}{{else}}N{{/if}}", { list: [1], no: 0 })).toBe("Y!");
    for (const value of ["", 0, false, null, undefined, []]) {
      expect(render("{{#if value}}Y{{else}}N{{/if}}", { value })).toBe("N");
    }
    expect(render("{{#if value}}Y{{/if}}", { value: {} })).toBe("Y");
  });

  test("iterates arrays with this, index, root fallback, nesting, and else", () => {
    const template = "{{#each groups}}[{{@index}}:{{this.name}}/{{title}}:{{#each this.items}}{{@index}}={{this}};{{else}}empty{{/each}}]{{else}}none{{/each}}";
    expect(render(template, { title: "T", groups: [{ name: "A", items: ["x", "y"] }, { name: "B", items: [] }] }))
      .toBe("[0:A/T:0=x;1=y;][1:B/T:empty]");
    expect(render("{{#each items}}x{{else}}none{{/each}}", { items: [] })).toBe("none");
  });

  test("removes comments", () => {
    expect(render("a{{! ignored }}b", {})).toBe("ab");
  });

  test("rejects non-scalar interpolation", () => {
    expect(() => render("x {{thing}}", { thing: { x: 1 } })).toThrow(/not scalar.*line 1, column 3/);
    expect(() => render("{{thing}}", { thing: [1] })).toThrow(/not scalar/);
  });

  test("reports structural errors with locations", () => {
    expect(() => render("one\n{{#wat x}}", {})).toThrow(/Unknown block.*line 2, column 1/);
    expect(() => render("{{#if x}}{{/each}}", {})).toThrow(/Mismatched.*line 1, column 10/);
    expect(() => render("{{#if x}}", {})).toThrow(/Unclosed block.*line 1, column 1/);
    expect(() => render("x{{else}}", {})).toThrow(/outside.*line 1, column 2/);
    expect(() => render("{{#if x}}{{else}}{{else}}{{/if}}", {})).toThrow(/Duplicate else.*column 19/);
    expect(() => render("{{/nope}}", {})).toThrow(/Unknown closing block.*line 1, column 1/);
  });
});
