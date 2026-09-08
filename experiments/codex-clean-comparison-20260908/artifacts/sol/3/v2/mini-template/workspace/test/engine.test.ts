import { describe, expect, test } from "bun:test";
import { render } from "../src/engine";

describe("render", () => {
  test("interpolates escaped, raw, nested, and missing values", () => {
    const data = { user: { name: `<Tom & "Sue's">` } };
    expect(render("{{user.name}}|{{{user.name}}}|{{missing}}", data)).toBe(
      "&lt;Tom &amp; &quot;Sue&#39;s&quot;&gt;|<Tom & \"Sue's\">|",
    );
  });

  test("supports nested conditionals and exact whitespace", () => {
    expect(render(" A\n{{#if a}}x{{#if b}}y{{else}}z{{/if}}{{else}}n{{/if}} B ", { a: true, b: false })).toBe(" A\nxz B ");
    for (const value of ["", 0, false, null, undefined, []]) {
      expect(render("{{#if value}}yes{{else}}no{{/if}}", { value })).toBe("no");
    }
    expect(render("{{#if value}}yes{{/if}}", { value: {} })).toBe("yes");
  });

  test("iterates arrays with local lookup, root fallback, index, and nesting", () => {
    const template = "{{#each groups}}[{{name}}/{{title}}:{{#each members}}{{@index}}={{this}}({{title}});{{else}}empty{{/each}}]{{else}}none{{/each}}";
    expect(render(template, {
      title: "ROOT",
      groups: [
        { name: "A", members: ["x", "y"] },
        { name: "B", members: [] },
      ],
    })).toBe("[A/ROOT:0=x(ROOT);1=y(ROOT);][B/ROOT:empty]");
  });

  test("removes comments", () => {
    expect(render("a{{! ignored }}b", {})).toBe("ab");
  });

  test("rejects nonscalar interpolation", () => {
    expect(() => render("hello {{user}}", { user: {} })).toThrow("cannot render object");
    expect(() => render("{{items}}", { items: [] })).toThrow("cannot render an array");
  });

  test("reports structural errors with line and column", () => {
    expect(() => render("x\n {{#wat x}}", {})).toThrow("line 2, column 2: unknown block");
    expect(() => render("{{#if x}}{{else}}{{else}}{{/if}}", {})).toThrow("duplicate else");
    expect(() => render("{{else}}", {})).toThrow("else outside a block");
    expect(() => render("{{#if x}}{{/each}}", {})).toThrow("mismatched closing block");
    expect(() => render("{{#each x}}", {})).toThrow("unclosed each block");
  });
});
