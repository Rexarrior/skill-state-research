import { describe, expect, test } from "bun:test";
import { render } from "../src/engine";

describe("render", () => {
  test("escapes interpolations and leaves triple braces raw", () => {
    const value = `&<>"'`;
    expect(render("{{value}}|{{{value}}}", { value })).toBe("&amp;&lt;&gt;&quot;&#39;|&<>\"'");
  });

  test("preserves whitespace, removes comments, and empties missing values", () => {
    expect(render(" a \n{{! ignored }}\t{{missing}} z ", {})).toBe(" a \n\t z ");
  });

  test("handles nested if blocks and specified truthiness", () => {
    expect(render("{{#if a}}A{{#if b}}B{{else}}C{{/if}}{{else}}D{{/if}}", { a: true, b: 0 })).toBe("AC");
    for (const value of ["", 0, false, null, undefined, []]) {
      expect(render("{{#if value}}yes{{else}}no{{/if}}", { value })).toBe("no");
    }
    expect(render("{{#if value}}yes{{else}}no{{/if}}", { value: {} })).toBe("yes");
  });

  test("iterates nested arrays with this, index, local lookup, and root fallback", () => {
    const template = "{{#each groups}}[{{name}}/{{title}}:{{#each this.items}}{{@index}}={{this}};{{else}}empty{{/each}}]{{else}}none{{/each}}";
    expect(render(template, {
      title: "root",
      groups: [{ name: "one", items: ["a", "b"] }, { name: "two", items: [] }],
    })).toBe("[one/root:0=a;1=b;][two/root:empty]");
    expect(render("{{#each items}}x{{else}}empty{{/each}}", { items: [] })).toBe("empty");
  });

  test("rejects non-scalar interpolations", () => {
    expect(() => render("line\n{{value}}", { value: { nested: true } })).toThrow("Cannot render non-scalar value at 'value' at line 2, column 1");
    expect(() => render("{{value}}", { value: [1] })).toThrow("Cannot render non-scalar");
  });

  test("reports structural errors with locations", () => {
    expect(() => render("x\n{{else}}", {})).toThrow("'else' outside a block at line 2, column 1");
    expect(() => render("{{#if x}}{{else}}{{else}}{{/if}}", {})).toThrow("Duplicate 'else'");
    expect(() => render("{{#if x}}{{/each}}", {})).toThrow("Mismatched closing block");
    expect(() => render("{{#wat x}}{{/wat}}", {})).toThrow("Unknown or malformed block 'wat'");
    expect(() => render("{{#if x}}", {})).toThrow("Unclosed 'if' block at line 1, column 1");
    expect(() => render("abc {{name", {})).toThrow("Unclosed tag at line 1, column 5");
  });
});
