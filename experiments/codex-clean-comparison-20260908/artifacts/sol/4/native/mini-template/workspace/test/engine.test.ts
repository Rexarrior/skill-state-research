import { describe, expect, test } from "bun:test";
import { render, TemplateError } from "../src/engine";

describe("render", () => {
  test("interpolates escaped, raw, missing, and scalar values", () => {
    const data = { html: `<a title="x's">&</a>`, count: 0, okay: false };
    expect(render("{{html}}|{{{html}}}|{{missing}}|{{count}}|{{okay}}", data)).toBe(
      "&lt;a title=&quot;x&#39;s&quot;&gt;&amp;&lt;/a&gt;|<a title=\"x's\">&</a>||0|false",
    );
  });

  test("handles if truthiness and nested branches", () => {
    expect(render("{{#if a}}A{{#if b}}B{{else}}C{{/if}}{{else}}D{{/if}}", { a: [], b: true })).toBe("D");
    expect(render("{{#if a}}A{{#if b}}B{{else}}C{{/if}}{{/if}}", { a: 1, b: 0 })).toBe("AC");
  });

  test("iterates with local values, indexes, root fallback, nesting, and else", () => {
    const template = "{{#each groups}}[{{name}}/{{title}}:{{#each this.items}}{{@index}}={{this}};{{else}}empty{{/each}}]{{else}}none{{/each}}";
    expect(render(template, { title: "T", groups: [{ name: "A", items: ["x", "y"] }, { name: "B", items: [] }] })).toBe(
      "[A/T:0=x;1=y;][B/T:empty]",
    );
    expect(render("{{#each items}}x{{else}}none{{/each}}", { items: null })).toBe("none");
  });

  test("preserves whitespace and removes comments", () => {
    expect(render(" a\n{{! ignored }}\n b ", {})).toBe(" a\n\n b ");
  });

  test("rejects non-scalars and reports structural locations", () => {
    expect(() => render("x {{value}}", { value: {} })).toThrow("not scalar text at line 1, column 3");
    expect(() => render("first\n{{#if x}}oops", { x: true })).toThrow("Unclosed #if block at line 2, column 1");
    expect(() => render("{{#if x}}{{else}}{{else}}{{/if}}", {})).toThrow("Duplicate else");
    expect(() => render("{{#if x}}{{/each}}", {})).toThrow("Mismatched closing block");
    expect(() => render("{{#wat x}}{{/wat}}", {})).toThrow(TemplateError);
  });
});
