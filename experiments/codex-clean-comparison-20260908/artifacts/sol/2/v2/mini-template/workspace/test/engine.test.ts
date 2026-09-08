import { describe, expect, test } from "bun:test";
import { render } from "../src/engine";

describe("render", () => {
  test("escapes interpolation and leaves triple interpolation raw", () => {
    const data = { value: `&<>"'` };
    expect(render("{{value}}|{{{value}}}", data)).toBe("&amp;&lt;&gt;&quot;&#39;|&<>\"'");
  });

  test("preserves whitespace and removes comments", () => {
    expect(render(" a\n {{! ignored }} \t b ", {})).toBe(" a\n  \t b ");
  });

  test("handles nested conditionals and specified false values", () => {
    expect(render("{{#if a}}A{{#if b}}B{{else}}C{{/if}}{{else}}D{{/if}}", { a: 1, b: 0 })).toBe("AC");
    for (const value of ["", 0, false, null, undefined, []]) {
      expect(render("{{#if value}}yes{{else}}no{{/if}}", { value })).toBe("no");
    }
    expect(render("{{#if value}}yes{{else}}no{{/if}}", { value: {} })).toBe("yes");
  });

  test("iterates nested arrays with local lookup and root fallback", () => {
    const template = "{{#each groups}}[{{@index}}:{{name}}/{{title}}={{#each values}}{{@index}}-{{this}};{{else}}empty{{/each}}]{{else}}none{{/each}}";
    expect(render(template, {
      title: "root",
      groups: [
        { name: "a", values: ["x", "y"] },
        { name: "b", values: [] },
      ],
    })).toBe("[0:a/root=0-x;1-y;][1:b/root=empty]");
  });

  test("uses each else for missing and non-array values", () => {
    expect(render("{{#each items}}x{{else}}empty{{/each}}", {})).toBe("empty");
    expect(render("{{#each items}}x{{else}}empty{{/each}}", { items: "no" })).toBe("empty");
  });

  test("renders missing values empty and rejects non-scalars", () => {
    expect(render("x{{missing.deep}}y", {})).toBe("xy");
    expect(() => render("{{value}}", { value: {} })).toThrow(/cannot be rendered.*line 1, column 1/);
    expect(() => render("\n{{value}}", { value: () => 1 })).toThrow(/function.*line 2, column 1/);
  });

  test("reports structural errors with line and column", () => {
    expect(() => render("one\n{{#wat x}}", {})).toThrow(/Unknown block.*line 2, column 1/);
    expect(() => render("{{else}}", {})).toThrow(/else outside.*line 1, column 1/);
    expect(() => render("{{#if x}}{{else}}{{else}}{{/if}}", {})).toThrow(/Duplicate else/);
    expect(() => render("{{#if x}}{{/each}}", {})).toThrow(/Mismatched.*expected \/if, got \/each/);
    expect(() => render("{{#if x}}", {})).toThrow(/Unclosed if block.*line 1, column 1/);
    expect(() => render("{{/if}}", {})).toThrow(/without an open block/);
    expect(() => render("hello {{name", {})).toThrow(/Unclosed tag.*column 7/);
  });
});

