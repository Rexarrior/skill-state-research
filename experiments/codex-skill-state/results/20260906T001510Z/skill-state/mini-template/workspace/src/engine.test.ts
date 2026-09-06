import { describe, expect, test } from "bun:test";
import { render } from "./engine";

describe("render", () => {
  test("escapes values and preserves raw values and whitespace", () => {
    expect(render(" A {{value}} / {{{value}}}\n", { value: `&<>\"'` }))
      .toBe(" A &amp;&lt;&gt;&quot;&#39; / &<>\"'\n");
  });

  test("renders missing and null values as empty text", () => {
    expect(render("{{missing}}-{{nil}}", { nil: null })).toBe("-");
  });

  test("supports nested conditionals and defined falsy rules", () => {
    const template = "{{#if ok}}yes {{#if items}}items{{else}}empty{{/if}}{{else}}no{{/if}}";
    expect(render(template, { ok: true, items: [] })).toBe("yes empty");
    for (const value of ["", 0, false, null, undefined, []]) {
      expect(render("{{#if value}}yes{{else}}no{{/if}}", { value })).toBe("no");
    }
  });

  test("iterates nested arrays with indexes and root fallback", () => {
    const template = "{{#each groups}}[{{name}}:{{#each this.items}}{{@index}}={{this}}/{{title}};{{else}}none{{/each}}]{{else}}no groups{{/each}}";
    const data = { title: "T", groups: [{ name: "A", items: ["x", "y"] }, { name: "B", items: [] }] };
    expect(render(template, data)).toBe("[A:0=x/T;1=y/T;][B:none]");
    expect(render(template, { title: "T", groups: [] })).toBe("no groups");
  });

  test("removes comments", () => {
    expect(render("a{{! ignored }}b", {})).toBe("ab");
  });

  test("rejects structural errors with locations", () => {
    const cases = [
      ["x\n{{#wat x}}", /Unknown block 'wat'.*line 2, column 1/],
      ["{{/if}}", /Unexpected closing block 'if'.*line 1, column 1/],
      ["{{#if x}}{{/each}}", /Mismatched closing block 'each'.*line 1, column 10/],
      ["{{#if x}}", /Unclosed block 'if'.*line 1, column 1/],
      ["{{else}}", /'else' outside a block.*line 1, column 1/],
      ["{{#if x}}{{else}}{{else}}{{/if}}", /Duplicate 'else'.*line 1, column 18/],
    ] as const;
    for (const [template, pattern] of cases) expect(() => render(template, {})).toThrow(pattern);
  });

  test("rejects non-scalar interpolation", () => {
    expect(() => render("value={{value}}", { value: { nested: true } }))
      .toThrow(/not scalar.*line 1, column 7/);
    expect(() => render("{{value}}", { value: () => 1 })).toThrow(/not scalar/);
  });
});
