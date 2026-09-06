import { expect, test } from "bun:test";
import { render } from "../src/engine";

test("escapes values and preserves whitespace", () => {
  expect(render(" a {{value}} b ", { value: "&<>\"'" })).toBe(" a &amp;&lt;&gt;&quot;&#39; b ");
  expect(render("{{{value}}}", { value: "<b>" })).toBe("<b>");
});

test("handles missing values, comments, and scalar errors", () => {
  expect(render("{{missing}}/{{! hidden }}ok", {})).toBe("/ok");
  expect(() => render("{{value}}", { value: {} })).toThrow("Cannot render an object");
});

test("renders nested conditionals with template truthiness", () => {
  expect(render("{{#if a}}A{{#if b}}B{{else}}C{{/if}}{{else}}D{{/if}}", { a: true, b: false })).toBe("AC");
  expect(render("{{#if items}}yes{{else}}no{{/if}}", { items: [] })).toBe("no");
});

test("renders loops, indexes, root fallback, and nested loops", () => {
  const template = "{{#each groups}}{{name}}:{{#each values}}{{@index}}={{this}}/{{title}};{{else}}empty{{/each}}|{{else}}none{{/each}}";
  expect(render(template, { title: "T", groups: [{ name: "a", values: ["x", "y"] }, { name: "b", values: [] }] })).toBe("a:0=x/T;1=y/T;|b:empty|");
});

test("reports structural errors with locations", () => {
  expect(() => render("x\n{{#if yes}}", {})).toThrow("line 2, column 1");
  expect(() => render("{{#if a}}{{/each}}", {})).toThrow("Mismatched closing block");
  expect(() => render("{{else}}", {})).toThrow("outside a block");
  expect(() => render("{{#wat x}}", {})).toThrow("Unknown block");
});
