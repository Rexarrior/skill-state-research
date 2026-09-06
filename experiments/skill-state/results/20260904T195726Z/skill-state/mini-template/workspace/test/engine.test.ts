import { describe, expect, test } from "bun:test";
import { render } from "../src/engine";

describe("render", () => {
  test("interpolates escaped and raw values", () => {
    const value = `&<>"'`;
    expect(render("{{value}}|{{{value}}}", { value })).toBe("&amp;&lt;&gt;&quot;&#39;|&<>\"'");
  });

  test("handles conditionals, comments, and specified false values", () => {
    expect(render("a{{! hidden }}{{#if value}}yes{{else}}no{{/if}}b", { value: [] })).toBe("anob");
    expect(render("{{#if value}}yes{{else}}no{{/if}}", { value: {} })).toBe("yes");
  });

  test("supports nested loops, local lookup, and root fallback", () => {
    const template = "{{#each groups}}[{{name}}:{{#each this.items}}{{@index}}={{this}}/{{title}};{{else}}empty{{/each}}]{{/each}}";
    const data = { title: "root", groups: [{ name: "A", items: ["x", "y"] }, { name: "B", items: [] }] };
    expect(render(template, data)).toBe("[A:0=x/root;1=y/root;][B:empty]");
  });

  test("renders missing values empty and preserves whitespace", () => {
    expect(render(" x\n  {{missing}} y ", {})).toBe(" x\n   y ");
  });

  test("rejects structural errors with locations", () => {
    expect(() => render("x\n{{#if ok}}{{/each}}", { ok: true })).toThrow("line 2, column 11");
    expect(() => render("{{else}}", {})).toThrow("Else outside");
    expect(() => render("{{#if x}}{{else}}{{else}}{{/if}}", {})).toThrow("Duplicate else");
    expect(() => render("{{#wat x}}", {})).toThrow("Unknown or invalid block");
    expect(() => render("{{#if x}}", {})).toThrow("Unclosed block");
  });

  test("rejects non-scalar interpolation", () => {
    expect(() => render("{{value}}", { value: { nested: true } })).toThrow("cannot be rendered as scalar text");
  });
});
