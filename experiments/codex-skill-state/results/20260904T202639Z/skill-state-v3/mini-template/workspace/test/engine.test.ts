import { describe, expect, test } from "bun:test";
import { render } from "../src/engine";

describe("render", () => {
  test("escapes interpolations and leaves triple braces raw", () => {
    const value = `&<>"'`;
    expect(render("{{value}}|{{{value}}}", { value })).toBe("&amp;&lt;&gt;&quot;&#39;|&<>\"'");
  });

  test("preserves whitespace, removes comments, and empties missing values", () => {
    expect(render(" a \n{{! ignored }}  {{missing}} z ", {})).toBe(" a \n   z ");
  });

  test("implements the specified truthiness", () => {
    for (const value of ["", 0, false, null, undefined, []]) {
      expect(render("{{#if value}}yes{{else}}no{{/if}}", { value })).toBe("no");
    }
    for (const value of ["0", 1, true, {}, [0]]) {
      expect(render("{{#if value}}yes{{else}}no{{/if}}", { value })).toBe("yes");
    }
  });

  test("supports nested loops, indexes, current values, and root fallback", () => {
    const template = "{{#each groups}}[{{name}}:{{#each items}}{{@index}}={{this}}/{{title}};{{else}}empty{{/each}}]{{/each}}";
    const data = {
      title: "root",
      groups: [
        { name: "a", items: ["x", "y"] },
        { name: "b", items: [] },
      ],
    };
    expect(render(template, data)).toBe("[a:0=x/root;1=y/root;][b:empty]");
  });

  test("uses each else for missing, non-array, and empty values", () => {
    expect(render("{{#each items}}x{{else}}empty{{/each}}", { items: "no" })).toBe("empty");
    expect(render("{{#each items}}x{{else}}empty{{/each}}", {})).toBe("empty");
  });

  test("rejects non-scalar interpolations", () => {
    expect(() => render("{{value}}", { value: {} })).toThrow("cannot be rendered as scalar text");
    expect(() => render("{{value}}", { value: [1] })).toThrow("cannot be rendered as scalar text");
    expect(() => render("{{value}}", { value: () => 1 })).toThrow("cannot be rendered as scalar text");
  });

  test("reports structural errors with line and column", () => {
    expect(() => render("one\n  {{#wat x}}", {})).toThrow('Unknown block "wat" at line 2, column 3');
    expect(() => render("{{else}}", {})).toThrow("else outside a block at line 1, column 1");
    expect(() => render("{{#if x}}{{else}}{{else}}{{/if}}", {})).toThrow("Duplicate else");
    expect(() => render("{{#if x}}{{/each}}", {})).toThrow("Mismatched close /each; expected /if");
    expect(() => render("{{#if x}}", {})).toThrow("Unclosed #if block at line 1, column 1");
    expect(() => render("{{/if}}", {})).toThrow("Closing /if without an open block");
  });
});
