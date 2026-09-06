import { describe, expect, test } from "bun:test";
import { render } from "../src/engine";

describe("render", () => {
  test("escapes interpolations and leaves triple braces raw", () => {
    const value = `&<>\"'`;
    expect(render("{{value}}|{{{value}}}", { value })).toBe("&amp;&lt;&gt;&quot;&#39;|&<>\"'");
  });

  test("renders missing values as empty strings", () => {
    expect(render("a{{missing.deep}}b", {})).toBe("ab");
  });

  test("implements the specified truthiness", () => {
    for (const value of ["", 0, false, null, undefined, []]) {
      expect(render("{{#if value}}yes{{else}}no{{/if}}", { value })).toBe("no");
    }
    for (const value of ["0", 1, true, {}, [0]]) {
      expect(render("{{#if value}}yes{{else}}no{{/if}}", { value })).toBe("yes");
    }
  });

  test("supports nested blocks, loop metadata, and root fallback", () => {
    const template = "{{#each groups}}[{{name}}/{{title}}:{{#each members}}{{@index}}={{this}};{{else}}none{{/each}}]{{/each}}";
    const data = { title: "team", groups: [{ name: "A", members: ["x", "y"] }, { name: "B", members: [] }] };
    expect(render(template, data)).toBe("[A/team:0=x;1=y;][B/team:none]");
  });

  test("preserves whitespace and removes comments", () => {
    expect(render(" a \n{{! ignored }}\n b ", {})).toBe(" a \n\n b ");
  });

  test("rejects non-scalar interpolation", () => {
    expect(() => render("{{value}}", { value: {} })).toThrow("not scalar");
    expect(() => render("{{value}}", { value: () => 1 })).toThrow("not scalar");
  });

  test("reports structural errors with line and column", () => {
    expect(() => render("line\n{{else}}", {})).toThrow("line 2, column 1");
    expect(() => render("{{#if x}}{{else}}{{else}}{{/if}}", {})).toThrow("Duplicate");
    expect(() => render("{{#if x}}{{/each}}", {})).toThrow("Mismatched");
    expect(() => render("{{#wat x}}", {})).toThrow("Unknown");
    expect(() => render("{{#each x}}", {})).toThrow("Unclosed block");
  });
});
