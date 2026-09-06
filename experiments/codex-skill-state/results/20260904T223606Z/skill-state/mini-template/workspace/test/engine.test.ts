import { expect, test } from "bun:test";
import { render } from "../src/engine";

test("interpolates and escapes HTML", () => {
  expect(render("Hi {{user.name}}", { user: { name: `<A & B's>` } })).toBe("Hi &lt;A &amp; B&#39;s&gt;");
  expect(render("{{{value}}}", { value: "<b>ok</b>" })).toBe("<b>ok</b>");
});

test("handles conditions, comments, and nesting", () => {
  expect(render("{{#if ok}}yes{{else}}no{{/if}}{{! ignored }}", { ok: false })).toBe("no");
  expect(render("{{#if items}}{{#each items}}{{this}}{{/each}}{{else}}empty{{/if}}", { items: [] })).toBe("empty");
});

test("iterates with root fallback and nested loops", () => {
  const template = "{{#each groups}}{{title}}:{{#each this}}{{@index}}={{this}}/{{../bad}}{{/each}};{{else}}none{{/each}}";
  expect(render(template, { title: "root", groups: [["a", "b"], ["c"]] })).toBe("root:0=a/1=b/;root:0=c/;");
  expect(render("{{#each values}}x{{else}}empty{{/each}}", { values: [] })).toBe("empty");
});

test("treats specified values as false and missing values as empty", () => {
  for (const value of ["", 0, false, null, undefined, []]) {
    expect(render("{{#if value}}yes{{else}}no{{/if}}", { value })).toBe("no");
  }
  expect(render("a{{missing.value}}b", {})).toBe("ab");
});

test("reports malformed structures and non-scalar render values", () => {
  expect(() => render("{{#wat x}}", {})).toThrow("line 1, column 1");
  expect(() => render("{{#if x}}{{/each}}", {})).toThrow("Mismatched");
  expect(() => render("{{else}}", {})).toThrow("outside");
  expect(() => render("{{#if x}}{{else}}{{else}}{{/if}}", {})).toThrow("Duplicate");
  expect(() => render("{{#if x}}", {})).toThrow("Unclosed");
  expect(() => render("{{value}}", { value: {} })).toThrow("Cannot render object");
});
