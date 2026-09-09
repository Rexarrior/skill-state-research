import { describe, expect, test } from "bun:test";
import { render } from "../src/engine";

describe("render", () => {
  test("escapes interpolations and leaves triple interpolations raw", () => {
    expect(render(`{{value}}|{{{value}}}`, { value: `&<>"'` }))
      .toBe(`&amp;&lt;&gt;&quot;&#39;|&<>"'`);
  });

  test("resolves nested paths and renders missing values as empty", () => {
    expect(render("Hello {{person.name}} {{missing}}!", { person: { name: "Ada" } }))
      .toBe("Hello Ada !");
  });

  test("supports nested conditionals and the specified truth rules", () => {
    const template = "{{#if items}}A{{#if enabled}}B{{else}}C{{/if}}{{else}}empty{{/if}}";
    expect(render(template, { items: [1], enabled: false })).toBe("AC");
    expect(render(template, { items: [], enabled: true })).toBe("empty");
    expect(render("{{#if value}}yes{{else}}no{{/if}}", { value: {} })).toBe("yes");
    for (const value of ["", 0, false, null, undefined, []]) {
      expect(render("{{#if value}}yes{{else}}no{{/if}}", { value })).toBe("no");
    }
  });

  test("iterates arrays with local values, root fallback, and nested loops", () => {
    const template = "{{#each groups}}[{{name}}/{{title}}:{{#each this.items}}{{@index}}={{this}};{{else}}none{{/each}}]{{else}}empty{{/each}}";
    const data = { title: "root", groups: [{ name: "A", items: ["x", "y"] }, { name: "B", items: [] }] };
    expect(render(template, data)).toBe("[A/root:0=x;1=y;][B/root:none]");
    expect(render("{{#each list}}x{{else}}empty{{/each}}", { list: "not an array" })).toBe("empty");
  });

  test("removes comments while preserving all surrounding whitespace", () => {
    expect(render(" a \n{{! ignored }}\t b ", {})).toBe(" a \n\t b ");
  });

  test("rejects structural errors with line and column", () => {
    expect(() => render("one\n{{#wat x}}", {})).toThrow("Unknown block 'wat' at line 2, column 1");
    expect(() => render("{{#if x}}{{else}}{{else}}{{/if}}", {})).toThrow("Duplicate else");
    expect(() => render("{{else}}", {})).toThrow("outside a block");
    expect(() => render("{{#if x}}\n{{/each}}", {})).toThrow("Mismatched closing block '/each'; expected '/if' at line 2, column 1");
    expect(() => render("x{{#each values}}", {})).toThrow("Unclosed block '#each' at line 1, column 2");
  });

  test("rejects non-scalar interpolation values", () => {
    expect(() => render("{{value}}", { value: { nested: true } }))
      .toThrow("Value at 'value' is not renderable as scalar text at line 1, column 1");
    expect(() => render("{{value}}", { value: () => "no" })).toThrow("not renderable");
  });
});
