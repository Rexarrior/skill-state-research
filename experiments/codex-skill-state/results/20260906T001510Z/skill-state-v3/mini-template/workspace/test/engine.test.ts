import { describe, expect, test } from "bun:test";
import { render } from "../src/engine";

describe("render", () => {
  test("interpolates escaped, raw, and missing values", () => {
    const data = { value: `&<>"'`, raw: "<b>ok</b>" };
    expect(render("{{value}}|{{{raw}}}|{{missing}}", data)).toBe(
      "&amp;&lt;&gt;&quot;&#39;|<b>ok</b>|",
    );
  });

  test("preserves whitespace and removes comments", () => {
    expect(render(" a \n{{! ignored }}\n b ", {})).toBe(" a \n\n b ");
  });

  test("implements specified truthiness and nested if blocks", () => {
    for (const value of ["", 0, false, null, undefined, []]) {
      expect(render("{{#if value}}yes{{else}}no{{/if}}", { value })).toBe("no");
    }
    for (const value of ["0", 1, true, {}, [0]]) {
      expect(render("{{#if value}}Y{{#if other}}!{{/if}}{{else}}N{{/if}}", { value, other: true })).toBe("Y!");
    }
  });

  test("iterates arrays with context, root fallback, else, and nesting", () => {
    const template = "{{#each groups}}[{{name}}/{{title}}:{{#each items}}{{@index}}={{this}};{{else}}empty{{/each}}]{{else}}none{{/each}}";
    expect(render(template, {
      title: "root",
      groups: [
        { name: "a", items: ["x", "y"] },
        { name: "b", items: [] },
      ],
    })).toBe("[a/root:0=x;1=y;][b/root:empty]");
    expect(render("{{#each values}}x{{else}}empty{{/each}}", { values: null })).toBe("empty");
  });

  test("rejects non-scalar interpolation", () => {
    expect(() => render("before {{value}}", { value: { nested: true } })).toThrow(/not scalar text.*line 1, column 8/);
    expect(() => render("{{value}}", { value: () => 1 })).toThrow(/not scalar text/);
  });

  test("reports structural errors with locations", () => {
    expect(() => render("x\n{{#wat value}}", {})).toThrow(/Unknown block.*line 2, column 1/);
    expect(() => render("{{#if ok}}{{/each}}", { ok: true })).toThrow(/Mismatched closing block.*line 1, column 11/);
    expect(() => render("{{#if ok}}", { ok: true })).toThrow(/Unclosed block.*line 1, column 1/);
    expect(() => render("{{else}}", {})).toThrow(/else outside.*line 1, column 1/);
    expect(() => render("{{#if ok}}a{{else}}b{{else}}c{{/if}}", { ok: true })).toThrow(/Duplicate else/);
    expect(() => render("{{value", {})).toThrow(/Unclosed tag.*line 1, column 1/);
  });
});
