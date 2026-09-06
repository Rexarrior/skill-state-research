import { expect, test } from "bun:test";
import { render } from "../src/engine";

test("interpolates escaped and raw values", () => {
  expect(render("{{value}}|{{{value}}}|{{missing}}", { value: `<&>\"'` })).toBe("&lt;&amp;&gt;&quot;&#39;|<&>\"'|");
});
test("conditionals support nesting and falsey values", () => {
  expect(render("{{#if user}}{{#if user.admin}}A{{else}}U{{/if}}{{else}}N{{/if}}", { user: { admin: false } })).toBe("U");
  expect(render("{{#if value}}yes{{else}}no{{/if}}", { value: [] })).toBe("no");
});
test("each supports context, root fallback, nesting, and else", () => {
  expect(render("{{#each rows}}{{title}}:{{@index}}={{this}};{{/each}}", { title: "T", rows: ["a", "b"] })).toBe("T:0=a;T:1=b;");
  expect(render("{{#each rows}}{{#each this}}{{@index}}={{this}}/{{/each}}{{/each}}", { rows: [[1, 2]] })).toBe("0=1/1=2/");
  expect(render("{{#each rows}}x{{else}}empty{{/each}}", { rows: [] })).toBe("empty");
});
test("comments and whitespace are preserved", () => {
  expect(render(" a {{! ignored }}\n{{x}} ", { x: "b" })).toBe(" a \nb ");
});
test("reports invalid structures and non-scalar values", () => {
  expect(() => render("{{else}}", {})).toThrow("line 1, column 1");
  expect(() => render("{{#if x}}{{/each}}", {})).toThrow("Mismatched");
  expect(() => render("{{#if x}}", {})).toThrow("Unclosed");
  expect(() => render("{{x}}", { x: {} })).toThrow("Cannot render object");
});
