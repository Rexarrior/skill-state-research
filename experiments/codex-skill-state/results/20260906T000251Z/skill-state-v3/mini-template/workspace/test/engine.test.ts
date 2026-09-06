import { describe, expect, test } from "bun:test";
import { render } from "../src/engine.ts";

describe("interpolation", () => {
  test("escapes HTML and supports raw values", () => {
    const value = `&<>"'`;
    expect(render("{{value}} | {{{value}}}", { value }))
      .toBe("&amp;&lt;&gt;&quot;&#39; | &<>\"'");
  });

  test("resolves nested and missing paths", () => {
    expect(render("{{user.name}}/{{user.missing}}", { user: { name: "Ada" } })).toBe("Ada/");
  });

  test("rejects non-scalar interpolation", () => {
    expect(() => render("x {{user}}", { user: { name: "Ada" } }))
      .toThrow("Value 'user' cannot be rendered as scalar text at line 1, column 3");
  });
});

describe("blocks", () => {
  test("uses the specified truthiness rules", () => {
    for (const value of ["", 0, 0n, false, null, undefined, []]) {
      expect(render("{{#if value}}yes{{else}}no{{/if}}", { value })).toBe("no");
    }
    for (const value of ["0", 1, {}, [0]]) {
      expect(render("{{#if value}}yes{{else}}no{{/if}}", { value })).toBe("yes");
    }
  });

  test("supports nested blocks", () => {
    const template = "{{#if ready}}{{#if ok}}A{{else}}B{{/if}}{{else}}C{{/if}}";
    expect(render(template, { ready: true, ok: false })).toBe("B");
  });

  test("iterates arrays with context and root fallback", () => {
    const template = "{{#each users}}[{{@index}}:{{this.name}}/{{title}}]{{else}}empty{{/each}}";
    expect(render(template, { title: "T", users: [{ name: "A" }, { name: "B" }] }))
      .toBe("[0:A/T][1:B/T]");
    expect(render(template, { title: "T", users: [] })).toBe("empty");
  });

  test("supports nested loops", () => {
    const template = "{{#each groups}}{{#each this}}({{@index}}={{this}}){{/each}}{{/each}}";
    expect(render(template, { groups: [["a", "b"], ["c"]] })).toBe("(0=a)(1=b)(0=c)");
  });
});

describe("syntax and preservation", () => {
  test("preserves whitespace and removes comments", () => {
    expect(render(" a\n {{! ignored }}\t b ", {})).toBe(" a\n \t b ");
  });

  test.each([
    ["{{#wat x}}{{/wat}}", "Unknown block", "line 1, column 1"],
    ["a\n{{else}}", "else outside a block", "line 2, column 1"],
    ["{{#if x}}{{else}}{{else}}{{/if}}", "Duplicate else", "line 1, column 18"],
    ["{{#if x}}{{/each}}", "Mismatched close", "line 1, column 10"],
    ["x {{#if x}}", "Unclosed if block", "line 1, column 3"],
    ["x {{name", "Unclosed tag", "line 1, column 3"],
  ])("reports structural error for %s", (template, message, location) => {
    expect(() => render(template, { x: true })).toThrow(message);
    expect(() => render(template, { x: true })).toThrow(location);
  });
});
