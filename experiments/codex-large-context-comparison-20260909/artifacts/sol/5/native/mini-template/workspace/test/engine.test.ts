import { describe, expect, test } from "bun:test";
import { render } from "../src/engine";

describe("interpolation", () => {
  test("escapes HTML and supports raw values", () => {
    const data = { value: `<a title="x">Tom & 'Sue'</a>` };
    expect(render("{{value}}|{{{value}}}", data)).toBe(
      "&lt;a title=&quot;x&quot;&gt;Tom &amp; &#39;Sue&#39;&lt;/a&gt;|<a title=\"x\">Tom & 'Sue'</a>",
    );
  });

  test("resolves nested paths and makes missing values empty", () => {
    expect(render("[{{user.name}}][{{user.missing}}]", { user: { name: "Ada" } })).toBe("[Ada][]");
  });

  test("rejects non-scalar interpolation", () => {
    expect(() => render("x\n{{value}}", { value: {} })).toThrow(/non-scalar.*line 2, column 1/);
    expect(() => render("{{value}}", { value: () => 1 })).toThrow(/non-scalar/);
  });
});

describe("blocks", () => {
  test("uses the specified truthiness rules and nested if blocks", () => {
    for (const value of ["", 0, false, null, undefined, []]) {
      expect(render("{{#if value}}yes{{else}}no{{/if}}", { value })).toBe("no");
    }
    expect(render("{{#if a}}A{{#if b}}B{{else}}C{{/if}}{{/if}}", { a: {}, b: true })).toBe("AB");
  });

  test("iterates, exposes context, falls back to root, and supports nesting", () => {
    const template = "{{#each rows}}[{{@index}}:{{name}}/{{title}}:{{#each cells}}{{@index}}={{this}};{{else}}empty{{/each}}]{{else}}none{{/each}}";
    const data = { title: "T", rows: [{ name: "A", cells: [1, 2] }, { name: "B", cells: [] }] };
    expect(render(template, data)).toBe("[0:A/T:0=1;1=2;][1:B/T:empty]");
  });

  test("renders each else for non-arrays and empty arrays", () => {
    expect(render("{{#each values}}x{{else}}empty{{/each}}", { values: [] })).toBe("empty");
    expect(render("{{#each values}}x{{else}}empty{{/each}}", { values: "no" })).toBe("empty");
  });
});

describe("syntax and whitespace", () => {
  test("preserves whitespace and removes comments", () => {
    expect(render(" a \n{{! ignored }}\n b ", {})).toBe(" a \n\n b ");
  });

  test.each([
    ["{{else}}", /else outside.*line 1, column 1/],
    ["{{#if x}}{{else}}{{else}}{{/if}}", /Duplicate else.*column 18/],
    ["{{#if x}}{{/each}}", /Mismatched.*column 10/],
    ["x\n{{#wat x}}{{/wat}}", /Unknown or malformed.*line 2, column 1/],
    ["x{{#if x}}", /Unclosed if.*line 1, column 2/],
  ])("reports structural error for %s", (template, pattern) => {
    expect(() => render(template, { x: true })).toThrow(pattern as RegExp);
  });
});
