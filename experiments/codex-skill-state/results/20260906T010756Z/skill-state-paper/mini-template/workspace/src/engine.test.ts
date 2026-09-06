import { describe, expect, test } from "bun:test";
import { render } from "./engine";

describe("render", () => {
  test("escapes double braces and preserves triple braces", () => {
    const data = { value: `&<>"'` };
    expect(render("{{value}}|{{{value}}}", data)).toBe("&amp;&lt;&gt;&quot;&#39;|&<>\"'");
  });

  test("renders missing values as empty strings", () => {
    expect(render("a{{missing.deep}}b", {})).toBe("ab");
  });

  test("handles if truthiness, else, nesting, and whitespace", () => {
    expect(render(" A {{#if users}}Y{{#if no}}N{{else}}!{{/if}}{{else}}X{{/if}} Z ", { users: [] }))
      .toBe(" A X Z ");
    expect(render("{{#if n}}yes{{else}}no{{/if}}", { n: 0 })).toBe("no");
  });

  test("iterates arrays with local values, root fallback, indexes, and nested loops", () => {
    const template = "{{#each groups}}[{{name}}/{{title}}:{{#each items}}{{@index}}={{this}};{{else}}none{{/each}}]{{/each}}";
    expect(render(template, {
      title: "root",
      groups: [{ name: "a", items: ["x", "y"] }, { name: "b", items: [] }],
    })).toBe("[a/root:0=x;1=y;][b/root:none]");
  });

  test("removes comments", () => {
    expect(render("x{{! ignored }}y", {})).toBe("xy");
  });

  test("rejects non-scalars", () => {
    expect(() => render("{{thing}}", { thing: {} })).toThrow("not scalar");
  });

  test("reports structural errors with locations", () => {
    expect(() => render("one\n{{#if x}}\n{{/each}}", {})).toThrow("line 3, column 1");
    expect(() => render("{{else}}", {})).toThrow("else outside");
    expect(() => render("{{#if x}}{{else}}{{else}}{{/if}}", {})).toThrow("Duplicate else");
    expect(() => render("{{#wat x}}{{/wat}}", {})).toThrow("Unknown or malformed block");
    expect(() => render("{{#if x}}", {})).toThrow("Unclosed if block");
  });
});
