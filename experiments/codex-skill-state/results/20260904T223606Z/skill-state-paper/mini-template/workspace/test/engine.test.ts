import { describe, expect, test } from "bun:test";
import { render } from "../src/engine";

describe("render", () => {
  test("interpolates and escapes scalar values", () => {
    expect(render("Hi {{user.name}}!", { user: { name: '<A & "B\'>' } })).toBe("Hi &lt;A &amp; &quot;B&#39;&gt;!");
    expect(render("{{{value}}}", { value: "<b>safe</b>" })).toBe("<b>safe</b>");
    expect(render("{{missing}}", {})).toBe("");
  });

  test("preserves whitespace and removes comments", () => {
    expect(render(" a\n{{! note }} b ", {})).toBe(" a\n b ");
  });

  test("supports nested conditionals with specified truthiness", () => {
    expect(render("{{#if value}}yes{{#if nested}}!{{else}}?{{/if}}{{else}}no{{/if}}", { value: [], nested: true })).toBe("no");
    expect(render("{{#if value}}yes{{else}}no{{/if}}", { value: "0" })).toBe("yes");
  });

  test("iterates including nested loops and root fallback", () => {
    const template = "{{#each groups}}{{title}}:{{#each this}}{{@index}}={{this}};{{/each}}|{{else}}empty{{/each}}";
    expect(render(template, { groups: [["a", "b"]], title: "Letters" })).toBe("Letters:0=a;1=b;|");
    expect(render("{{#each values}}x{{else}}none{{/each}}", { values: [] })).toBe("none");
  });

  test("rejects invalid structures and non-scalar interpolation", () => {
    expect(() => render("{{else}}", {})).toThrow(/line 1, column 1/);
    expect(() => render("{{#if a}}{{/each}}", {})).toThrow(/Mismatched/);
    expect(() => render("{{#wat x}}", {})).toThrow(/Unknown block/);
    expect(() => render("{{#if a}}", {})).toThrow(/Unclosed/);
    expect(() => render("{{value}}", { value: {} })).toThrow(/Cannot render/);
  });
});
