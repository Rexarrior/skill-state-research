import { expect, test } from "bun:test";
import { render } from "../src/engine";

test("interpolates and escapes HTML", () => {
  expect(render("Hello {{name}}", { name: "A & <B>\"'" })).toBe("Hello A &amp; &lt;B&gt;&quot;&#39;");
  expect(render("{{{name}}}", { name: "<b>x</b>" })).toBe("<b>x</b>");
});

test("handles comments, missing values, and whitespace", () => {
  expect(render("a {{! ignored }}\n{{missing}} b", {})).toBe("a \n b");
});

test("handles nested conditionals and falsey values", () => {
  const template = "{{#if enabled}}yes {{#if name}}{{name}}{{else}}anon{{/if}}{{else}}no{{/if}}";
  expect(render(template, { enabled: true, name: "Ada" })).toBe("yes Ada");
  expect(render(template, { enabled: true, name: "" })).toBe("yes anon");
  expect(render("{{#if items}}some{{else}}none{{/if}}", { items: [] })).toBe("none");
});

test("iterates with this, index, root fallback, nesting, and else", () => {
  expect(render("{{#each rows}}{{title}}:{{@index}}={{this}};{{else}}empty{{/each}}", { title: "T", rows: ["a", "b"] })).toBe("T:0=a;T:1=b;");
  expect(render("{{#each rows}}{{this.name}}[{{#each this.items}}{{this}}{{/each}}]{{/each}}", { rows: [{ name: "a", items: [1, 2] }] })).toBe("a[12]");
  expect(render("{{#each rows}}x{{else}}empty{{/each}}", { rows: [] })).toBe("empty");
});

test("reports structural and scalar rendering errors", () => {
  expect(() => render("{{#wat x}}", {})).toThrow("Unknown block");
  expect(() => render("{{else}}", {})).toThrow("line 1, column 1");
  expect(() => render("{{#if x}}{{/each}}", {})).toThrow("Mismatched closing block");
  expect(() => render("{{#if x}}", {})).toThrow("Unclosed block");
  expect(() => render("{{value}}", { value: {} })).toThrow("Cannot render object");
});
