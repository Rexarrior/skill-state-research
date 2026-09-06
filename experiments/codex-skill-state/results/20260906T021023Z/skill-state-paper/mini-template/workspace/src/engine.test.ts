import { describe, expect, test } from "bun:test";
import { render } from "./engine";

describe("render", () => {
  test("escapes interpolations and leaves triple braces raw", () => {
    const value = `&<>"'`;
    expect(render("{{value}}|{{{value}}}", { value })).toBe("&amp;&lt;&gt;&quot;&#39;|&<>\"'");
  });

  test("renders missing values empty and preserves whitespace", () => {
    expect(render(" a {{missing}} \n b ", {})).toBe(" a  \n b ");
  });

  test("supports nested conditionals and custom truthiness", () => {
    expect(render("{{#if a}}A{{#if b}}B{{else}}C{{/if}}{{else}}D{{/if}}", { a: [], b: true })).toBe("D");
    expect(render("{{#if a}}yes{{else}}no{{/if}}", { a: {} })).toBe("yes");
  });

  test("iterates arrays with locals, root fallback, and nesting", () => {
    const template = "{{#each groups}}{{name}}={{#each items}}[{{@index}}:{{this}}/{{title}}]{{else}}empty{{/each}};{{/each}}";
    const data = { title: "root", groups: [{ name: "a", items: ["x", "y"] }, { name: "b", items: [] }] };
    expect(render(template, data)).toBe("a=[0:x/root][1:y/root];b=empty;");
  });

  test("uses each else for missing and non-array values", () => {
    expect(render("{{#each items}}x{{else}}none{{/each}}", { items: "no" })).toBe("none");
  });

  test("removes comments", () => {
    expect(render("a{{! ignored }}b", {})).toBe("ab");
  });

  test("rejects non-scalar interpolation", () => {
    expect(() => render("x {{value}}", { value: {} })).toThrow(/Cannot render object.*line 1, column 3/);
  });

  test.each([
    ["{{else}}", /outside.*line 1, column 1/],
    ["{{#if x}}a{{else}}b{{else}}c{{/if}}", /Duplicate.*line 1, column 20/],
    ["{{#if x}}{{/each}}", /Mismatched.*line 1, column 10/],
    ["{{#wat x}}", /Unknown.*line 1, column 1/],
    ["\n{{#if x}}", /Unclosed.*line 2, column 1/],
  ])("reports structural error positions", (template, message) => {
    expect(() => render(template, {})).toThrow(message);
  });
});
