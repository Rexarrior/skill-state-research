import { describe, expect, test } from "bun:test";
import { render } from "../src/engine";

describe("render", () => {
  test("escapes values and supports raw values and comments", () => {
    expect(render("A {{value}} B {{{value}}}{{! ignored }}", { value: `&<>\"'` }))
      .toBe("A &amp;&lt;&gt;&quot;&#39; B &<>\"'");
  });

  test("renders missing values as empty strings", () => {
    expect(render("x{{missing.deep}}y", {})).toBe("xy");
  });

  test("handles if truthiness, nesting, and else", () => {
    expect(render("{{#if a}}A{{#if b}}B{{else}}C{{/if}}{{else}}D{{/if}}", { a: [], b: true }))
      .toBe("D");
    expect(render("{{#if a}}A{{#if b}}B{{else}}C{{/if}}{{else}}D{{/if}}", { a: [1], b: 0 }))
      .toBe("AC");
  });

  test("iterates nested arrays with item paths, index, and root fallback", () => {
    const template = "{{#each groups}}[{{name}}/{{title}}:{{#each values}}{{@index}}={{this}};{{else}}empty{{/each}}]{{/each}}";
    expect(render(template, {
      title: "root",
      groups: [{ name: "a", values: ["x", "y"] }, { name: "b", values: [] }],
    })).toBe("[a/root:0=x;1=y;][b/root:empty]");
  });

  test("each else handles missing and non-array values", () => {
    expect(render("{{#each items}}x{{else}}none{{/each}}", { items: "no" })).toBe("none");
  });

  test("preserves whitespace exactly", () => {
    expect(render(" \n{{! x }}\t{{value}}\n", { value: "ok" })).toBe(" \n\tok\n");
  });

  test("rejects structural errors with locations", () => {
    expect(() => render("one\n{{else}}", {})).toThrow("else outside a block at line 2, column 1");
    expect(() => render("{{#if x}}{{else}}{{else}}{{/if}}", {})).toThrow("Duplicate else");
    expect(() => render("{{#if x}}{{/each}}", {})).toThrow("expected /if, got /each");
    expect(() => render("{{#wat x}}{{/wat}}", {})).toThrow('Unknown block "wat"');
    expect(() => render("{{#if x}}", {})).toThrow("Unclosed #if block");
  });

  test("rejects non-scalar interpolation", () => {
    expect(() => render("{{user}}", { user: { name: "Ada" } })).toThrow(
      'Cannot render non-scalar value at path "user" at line 1, column 1',
    );
  });
});
