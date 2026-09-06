import { expect, test } from "bun:test";
import { render } from "../src/engine.ts";

test("interpolates escaped, raw, and missing values", () => {
  expect(render("{{name}} {{{name}}} {{missing}}", { name: '<&"\'' })).toBe("&lt;&amp;&quot;&#39; <&\"' ");
});

test("supports comments and preserves whitespace", () => {
  expect(render(" a {{! ignored }}\n b ", {})).toBe(" a \n b ");
});

test("supports nested conditional blocks and template truthiness", () => {
  expect(render("{{#if a}}A{{#if b}}B{{else}}C{{/if}}{{else}}D{{/if}}", { a: true, b: 0 })).toBe("AC");
  expect(render("{{#if items}}yes{{else}}no{{/if}}", { items: [] })).toBe("no");
});

test("iterates with this, index, root fallback, nested loops, and else", () => {
  const template = "{{#each rows}}{{title}}:{{@index}}={{#each values}}{{this}}/{{title}};{{/each}}{{else}}empty{{/each}}";
  expect(render(template, { rows: [{ title: "a", values: [1, 2] }, { title: "b", values: [3] }] })).toBe("a:0=1/;2/;b:1=3/;");
  expect(render("{{#each rows}}x{{else}}none{{/each}}", { rows: [] })).toBe("none");
});

test("rejects structural errors with locations", () => {
  expect(() => render("x\n{{else}}", {})).toThrow("line 2, column 1");
  expect(() => render("{{#if ok}}{{/each}}", {})).toThrow("Mismatched");
  expect(() => render("{{#wat nope}}", {})).toThrow("Unknown block");
  expect(() => render("{{#if ok}}", {})).toThrow("Unclosed");
});

test("rejects non-scalar interpolation values", () => {
  expect(() => render("{{value}}", { value: {} })).toThrow("Cannot render object");
  expect(() => render("{{value}}", { value: () => 1 })).toThrow("Cannot render function");
});
