import { describe, expect, test } from "bun:test";
import { render } from "../src/engine";

describe("render", () => {
  test("escapes interpolations and preserves raw values", () => {
    const data = { value: `&<>"'`, absent: undefined };
    expect(render("{{value}}|{{{value}}}|{{absent}}", data)).toBe(
      "&amp;&lt;&gt;&quot;&#39;|&<>\"'|",
    );
  });

  test("handles nested if blocks and specified truthiness", () => {
    expect(render("{{#if a}}A{{#if b}}B{{else}}C{{/if}}{{else}}D{{/if}}", { a: 1, b: 0 })).toBe("AC");
    for (const value of ["", 0, false, null, undefined, []]) {
      expect(render("{{#if value}}yes{{else}}no{{/if}}", { value })).toBe("no");
    }
  });

  test("iterates nested arrays with root fallback", () => {
    const template = "{{#each groups}}[{{name}}:{{#each this.items}}{{@index}}={{this}}/{{title}};{{else}}empty{{/each}}]{{else}}none{{/each}}";
    expect(render(template, {
      title: "root",
      groups: [{ name: "a", items: ["x", "y"] }, { name: "b", items: [] }],
    })).toBe("[a:0=x/root;1=y/root;][b:empty]");
    expect(render("{{#each values}}x{{else}}empty{{/each}}", { values: "not an array" })).toBe("empty");
  });

  test("removes comments and preserves other whitespace", () => {
    expect(render(" a \n{{! ignored }}\n b ", {})).toBe(" a \n\n b ");
  });

  test("rejects malformed structures with locations", () => {
    expect(() => render("x\n{{else}}", {})).toThrow("line 2, column 1");
    expect(() => render("{{#if x}}{{else}}{{else}}{{/if}}", { x: true })).toThrow("Duplicate else");
    expect(() => render("{{#if x}}{{/each}}", {})).toThrow("Mismatched closing block");
    expect(() => render("{{#wat x}}{{/wat}}", {})).toThrow("Unknown block 'wat'");
    expect(() => render("{{#if x}}", {})).toThrow("Unclosed block '#if'");
  });

  test("rejects non-scalar interpolation", () => {
    expect(() => render("{{thing}}", { thing: {} })).toThrow("not scalar");
    expect(() => render("{{thing}}", { thing: () => 1 })).toThrow("not scalar");
  });
});
