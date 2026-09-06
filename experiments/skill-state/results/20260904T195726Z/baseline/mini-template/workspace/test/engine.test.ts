import { describe, expect, test } from "bun:test";
import { render } from "../src/engine";

describe("render", () => {
  test("escapes interpolations and leaves triple braces unescaped", () => {
    const value = `&<>"'`;
    expect(render("{{value}}|{{{value}}}", { value })).toBe("&amp;&lt;&gt;&quot;&#39;|&<>\"'");
  });

  test("preserves text and removes comments", () => {
    expect(render(" a\n{{! ignored }} b ", {})).toBe(" a\n b ");
  });

  test("supports nested conditions and specified truthiness", () => {
    const template = "{{#if outer}}A{{#if inner}}B{{else}}C{{/if}}{{else}}D{{/if}}";
    expect(render(template, { outer: [], inner: true })).toBe("D");
    expect(render(template, { outer: [1], inner: 0 })).toBe("AC");
  });

  test("iterates nested arrays with local values, root fallback, and indexes", () => {
    const template = "{{#each groups}}[{{name}}/{{title}}:{{#each this.items}}{{@index}}={{this}};{{else}}empty{{/each}}]{{/each}}";
    expect(render(template, {
      title: "root",
      groups: [
        { name: "a", items: ["x", "y"] },
        { name: "b", items: [] },
      ],
    })).toBe("[a/root:0=x;1=y;][b/root:empty]");
  });

  test("renders missing values as empty strings", () => {
    expect(render("x{{missing.deep}}y", {})).toBe("xy");
  });

  test("rejects nonscalar values", () => {
    expect(() => render("line\n{{value}}", { value: {} })).toThrow(
      "Value 'value' cannot be rendered as scalar text at line 2, column 1",
    );
  });

  test.each([
    ["{{#wat x}}{{/wat}}", "Unknown block 'wat' at line 1, column 1"],
    ["{{else}}", "else outside a block at line 1, column 1"],
    ["{{#if x}}{{else}}{{else}}{{/if}}", "Duplicate else at line 1, column 18"],
    ["{{#if x}}{{/each}}", "Mismatched closing block 'each', expected 'if' at line 1, column 10"],
    ["{{#if x}}", "Unclosed block 'if' at line 1, column 1"],
    ["text {{name", "Unclosed tag at line 1, column 6"],
  ])("reports structural error for %s", (template, message) => {
    expect(() => render(template, { x: true })).toThrow(message);
  });
});
