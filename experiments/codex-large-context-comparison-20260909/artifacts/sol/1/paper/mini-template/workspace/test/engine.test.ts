import { describe, expect, test } from "bun:test";
import { render } from "../src/engine.ts";

describe("render", () => {
  test("interpolates escaped and raw scalar values", () => {
    const data = { value: `&<>"'`, zero: 0, no: false };
    expect(render("{{value}} | {{{value}}} | {{zero}} {{no}} {{missing}}", data))
      .toBe("&amp;&lt;&gt;&quot;&#39; | &<>\"' | 0 false ");
  });

  test("handles nested conditionals and specified truthiness", () => {
    expect(render("{{#if a}}A{{#if b}}B{{else}}C{{/if}}{{else}}D{{/if}}", { a: [], b: true }))
      .toBe("D");
    expect(render("{{#if a}}yes{{else}}no{{/if}}", { a: {} })).toBe("yes");
    expect(render("{{#if a}}yes{{else}}no{{/if}}", { a: 0 })).toBe("no");
  });

  test("iterates nested arrays with current contexts and root fallback", () => {
    const template = "{{#each groups}}[{{@index}}:{{this.name}}={{#each this.items}}({{@index}},{{this}},{{title}}){{else}}empty{{/each}}]{{else}}none{{/each}}";
    const data = { title: "T", groups: [{ name: "a", items: [1, 2] }, { name: "b", items: [] }] };
    expect(render(template, data)).toBe("[0:a=(0,1,T)(1,2,T)][1:b=empty]");
  });

  test("preserves whitespace and removes comments", () => {
    expect(render(" a\n{{! ignore me }}  b ", {})).toBe(" a\n  b ");
  });

  test("rejects structural mistakes with locations", () => {
    expect(() => render("x\n{{#wat x}}", {})).toThrow("Unknown block 'wat' at line 2, column 1");
    expect(() => render("{{#if x}}{{else}}{{else}}{{/if}}", {})).toThrow("Duplicate 'else'");
    expect(() => render("{{#if x}}{{/each}}", {})).toThrow("expected '/if'");
    expect(() => render("{{#each x}}", {})).toThrow("Unclosed '#each' block");
    expect(() => render("{{else}}", {})).toThrow("outside a block");
  });

  test("rejects non-scalar interpolation", () => {
    expect(() => render("{{user}}", { user: { name: "Ada" } })).toThrow("not scalar");
    expect(() => render("{{items}}", { items: [] })).toThrow("not scalar");
  });
});
