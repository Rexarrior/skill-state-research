import { describe, expect, test } from "bun:test";
import { render } from "../src/engine";

describe("interpolation", () => {
  test("escapes HTML and supports raw values", () => {
    const value = `<a title="x">Tom & Jerry's</a>`;
    expect(render("{{value}}|{{{value}}}", { value })).toBe(
      "&lt;a title=&quot;x&quot;&gt;Tom &amp; Jerry&#39;s&lt;/a&gt;|" + value,
    );
  });

  test("renders missing and null values as empty strings", () => {
    expect(render("a{{missing}}b{{nil}}c", { nil: null })).toBe("abc");
  });

  test("rejects non-scalar interpolation", () => {
    expect(() => render("first\n{{user}}", { user: { name: "Ada" } })).toThrow(
      /not scalar text.*line 2, column 1/,
    );
  });
});

describe("blocks", () => {
  test("implements the specified truthiness and nested if blocks", () => {
    for (const value of ["", 0, false, null, undefined, []]) {
      expect(render("{{#if value}}yes{{else}}no{{/if}}", { value })).toBe("no");
    }
    expect(render("{{#if a}}A{{#if b}}B{{else}}C{{/if}}{{/if}}", { a: true, b: 1 })).toBe("AB");
  });

  test("iterates arrays with local values, indices, root fallback, and nesting", () => {
    const template = "{{#each groups}}[{{name}}/{{title}}:{{#each this.items}}{{@index}}={{this}};{{else}}empty{{/each}}]{{else}}none{{/each}}";
    expect(render(template, {
      title: "root",
      groups: [{ name: "A", items: ["x", "y"] }, { name: "B", items: [] }],
    })).toBe("[A/root:0=x;1=y;][B/root:empty]");
  });

  test("uses each else for non-arrays and empty arrays", () => {
    expect(render("{{#each values}}x{{else}}empty{{/each}}", { values: [] })).toBe("empty");
    expect(render("{{#each values}}x{{else}}empty{{/each}}", { values: "no" })).toBe("empty");
  });
});

describe("syntax and preservation", () => {
  test("preserves whitespace and removes comments", () => {
    expect(render("  a\n{{! ignored }}\t b  ", {})).toBe("  a\n\t b  ");
  });

  test("reports structural errors with locations", () => {
    expect(() => render("x\n{{else}}", {})).toThrow(/Else outside.*line 2, column 1/);
    expect(() => render("{{#if a}}{{else}}{{else}}{{/if}}", { a: true })).toThrow(/Duplicate else/);
    expect(() => render("{{#if a}}{{/each}}", { a: true })).toThrow(/Mismatched.*line 1, column 10/);
    expect(() => render("before {{#wat x}}", {})).toThrow(/Unknown block.*line 1, column 8/);
    expect(() => render("{{#each xs}}", { xs: [] })).toThrow(/Unclosed each block.*line 1, column 1/);
  });
});
