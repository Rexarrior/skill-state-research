import { describe, expect, test } from "bun:test";
import { render } from "../src/engine";

describe("render", () => {
  test("escapes interpolations and leaves triple braces raw", () => {
    const value = `&<>"'`;
    expect(render("{{value}} / {{{value}}}", { value })).toBe(
      `&amp;&lt;&gt;&quot;&#39; / &<>"'`,
    );
  });

  test("resolves nested paths and renders missing/null values empty", () => {
    expect(render("{{user.name}}|{{missing}}|{{nil}}", { user: { name: "Ada" }, nil: null }))
      .toBe("Ada||");
  });

  test("preserves whitespace and removes comments", () => {
    expect(render(" a\n {{! nothing }} \n b ", {})).toBe(" a\n  \n b ");
  });

  test("supports nested if blocks and specified truthiness", () => {
    expect(render("{{#if a}}A{{#if b}}B{{else}}C{{/if}}{{else}}D{{/if}}", { a: 1, b: 0 }))
      .toBe("AC");
    for (const value of ["", 0, false, null, undefined, []]) {
      expect(render("{{#if x}}yes{{else}}no{{/if}}", { x: value })).toBe("no");
    }
    for (const value of [true, 1, {}, [0]]) {
      expect(render("{{#if x}}yes{{else}}no{{/if}}", { x: value })).toBe("yes");
    }
  });

  test("iterates arrays with this, index, local paths, and root fallback", () => {
    const template = "{{#each users}}[{{@index}}:{{name}}/{{site}}/{{this.name}}]{{else}}empty{{/each}}";
    expect(render(template, { site: "HQ", users: [{ name: "A" }, { name: "B" }] }))
      .toBe("[0:A/HQ/A][1:B/HQ/B]");
    expect(render(template, { site: "HQ", users: [] })).toBe("empty");
  });

  test("supports nested loops", () => {
    const template = "{{#each rows}}{{@index}}:{{#each this}}{{@index}}={{this}};{{/each}}|{{/each}}";
    expect(render(template, { rows: [["a", "b"], ["c"]] })).toBe("0:0=a;1=b;|1:0=c;|");
  });

  test("each else is used for missing and non-array values", () => {
    expect(render("{{#each x}}x{{else}}none{{/each}}", {})).toBe("none");
    expect(render("{{#each x}}x{{else}}none{{/each}}", { x: "no" })).toBe("none");
  });

  test("rejects non-scalar interpolation", () => {
    expect(() => render("hello {{user}}", { user: { name: "Ada" } }))
      .toThrow("Cannot render non-scalar value at path 'user' at line 1, column 7");
    expect(() => render("{{fn}}", { fn() {} })).toThrow("Cannot render non-scalar");
  });

  test("reports structural errors with line and column", () => {
    expect(() => render("x\n{{#wat x}}", {})).toThrow("Unknown block 'wat' at line 2, column 1");
    expect(() => render("{{#if x}}{{/each}}", {})).toThrow("expected '/if', got '/each'");
    expect(() => render("{{#if x}}a", {})).toThrow("Unclosed 'if' block at line 1, column 1");
    expect(() => render("x{{else}}", {})).toThrow("'else' outside a block at line 1, column 2");
    expect(() => render("{{#if x}}{{else}}{{else}}{{/if}}", {})).toThrow("Duplicate 'else'");
    expect(() => render("{{/if}}", {})).toThrow("Unexpected closing block '/if'");
    expect(() => render("{{name", {})).toThrow("Unclosed tag at line 1, column 1");
  });
});
