import { describe, expect, test } from "bun:test";
import { render, TemplateError } from "../src/engine.ts";

describe("render", () => {
  test("interpolates escaped, raw, missing, and scalar values", () => {
    const data = { dangerous: `<a href="x">Tom & 'Ada'</a>`, count: 0 };
    expect(render("{{dangerous}} | {{{dangerous}}} | {{missing}} | {{count}}", data)).toBe(
      "&lt;a href=&quot;x&quot;&gt;Tom &amp; &#39;Ada&#39;&lt;/a&gt; | <a href=\"x\">Tom & 'Ada'</a> |  | 0",
    );
  });

  test("preserves whitespace and removes comments", () => {
    expect(render(" a\n{{! ignored }} \t b ", {})).toBe(" a\n \t b ");
  });

  test("supports nested conditions and the specified truthiness", () => {
    expect(render("{{#if a}}A{{#if b}}B{{else}}C{{/if}}{{else}}D{{/if}}", { a: true, b: 0 })).toBe("AC");
    for (const value of ["", 0, false, null, undefined, []]) {
      expect(render("{{#if value}}yes{{else}}no{{/if}}", { value })).toBe("no");
    }
    expect(render("{{#if value}}yes{{else}}no{{/if}}", { value: {} })).toBe("yes");
  });

  test("iterates nested arrays with innermost context and root fallback", () => {
    const template = "{{#each groups}}[{{@index}}:{{this.name}}/{{title}} {{#each this.items}}({{@index}}={{this}}/{{title}}){{else}}empty{{/each}}]{{else}}none{{/each}}";
    expect(render(template, {
      title: "root",
      groups: [{ name: "A", items: ["x", "y"] }, { name: "B", items: [] }],
    })).toBe("[0:A/root (0=x/root)(1=y/root)][1:B/root empty]");
    expect(render("{{#each items}}x{{else}}empty{{/each}}", { items: [] })).toBe("empty");
    expect(render("{{#each missing}}x{{else}}empty{{/each}}", {})).toBe("empty");
  });

  test("rejects non-scalar interpolation", () => {
    expect(() => render("before {{thing}}", { thing: { x: 1 } })).toThrow('Value at "thing" is not scalar at line 1, column 8');
    expect(() => render("{{thing}}", { thing: () => 1 })).toThrow(TemplateError);
  });

  test("reports structural errors with line and column", () => {
    const cases: Array<[string, string]> = [
      ["x\n{{else}}", "else outside a block at line 2, column 1"],
      ["{{#if ok}}{{else}}{{else}}{{/if}}", "Duplicate else at line 1, column 19"],
      ["{{#if ok}}{{/each}}", "Mismatched closing block: expected /if, got /each at line 1, column 11"],
      ["{{/if}}", "Closing if without an open block at line 1, column 1"],
      ["{{#wat x}}", 'Unknown block "wat" at line 1, column 1'],
      ["{{#if ok}}", "Unclosed if block at line 1, column 1"],
      ["hello {{name", "Unclosed tag at line 1, column 7"],
    ];
    for (const [template, message] of cases) {
      expect(() => render(template, { ok: true })).toThrow(message);
    }
  });
});
