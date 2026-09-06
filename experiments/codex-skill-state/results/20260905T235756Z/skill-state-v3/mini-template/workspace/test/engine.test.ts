import { describe, expect, test } from "bun:test";
import { render } from "../src/engine";

describe("interpolation", () => {
  test("escapes HTML and supports raw values", () => {
    const value = `&<>"'`;
    expect(render("{{value}}|{{{value}}}", { value })).toBe("&amp;&lt;&gt;&quot;&#39;|&<>\"'");
  });

  test("resolves nested paths and renders missing values as empty", () => {
    expect(render("Hello {{user.name}}!{{missing}}", { user: { name: "Ada" } })).toBe("Hello Ada!");
  });

  test("rejects values that are not scalar text", () => {
    expect(() => render("before {{user}}", { user: { name: "Ada" } })).toThrow(/non-scalar.*line 1, column 8/);
    expect(() => render("{{fn}}", { fn() {} })).toThrow(/non-scalar/);
  });
});

describe("blocks", () => {
  test("implements the specified truthiness rules", () => {
    const template = "{{#if value}}yes{{else}}no{{/if}}";
    for (const value of ["", 0, -0, false, null, undefined, []]) {
      expect(render(template, { value })).toBe("no");
    }
    for (const value of ["0", true, {}, [0], NaN]) {
      expect(render(template, { value })).toBe("yes");
    }
  });

  test("supports nested if blocks", () => {
    expect(render("{{#if a}}A{{#if b}}B{{else}}C{{/if}}{{else}}D{{/if}}", { a: true, b: false })).toBe("AC");
  });

  test("iterates arrays with locals, root fallback, nesting, and else", () => {
    const template = "{{#each groups}}[{{name}}/{{title}}:{{#each items}}{{@index}}={{this}};{{else}}empty{{/each}}]{{else}}none{{/each}}";
    const data = {
      title: "root",
      groups: [
        { name: "a", items: ["x", "y"] },
        { name: "b", items: [] },
      ],
    };
    expect(render(template, data)).toBe("[a/root:0=x;1=y;][b/root:empty]");
    expect(render("{{#each rows}}x{{else}}none{{/each}}", { rows: [] })).toBe("none");
  });

  test("preserves whitespace and removes comments", () => {
    expect(render(" a\n  {{! ignore me }}\n b ", {})).toBe(" a\n  \n b ");
  });
});

describe("syntax errors", () => {
  test.each([
    ["{{#wat x}}", /Unknown block 'wat'.*line 1, column 1/],
    ["x\n{{else}}", /outside a block.*line 2, column 1/],
    ["{{#if x}}{{else}}{{else}}{{/if}}", /Duplicate else.*line 1, column 18/],
    ["{{#if x}}{{/each}}", /Mismatched closing block.*line 1, column 10/],
    ["{{/if}}", /Unexpected closing block.*line 1, column 1/],
    ["{{#each x}}", /Unclosed 'each' block.*line 1, column 1/],
    ["hello {{name", /Unclosed template tag.*line 1, column 7/],
  ])("reports useful location for %s", (template, pattern) => {
    expect(() => render(template, {})).toThrow(pattern);
  });
});
