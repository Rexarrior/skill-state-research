import { describe, expect, test } from "bun:test";
import { render, TemplateError } from "../src/engine";

describe("render", () => {
  test("escapes interpolations and leaves triple braces raw", () => {
    expect(render(`{{value}} | {{{value}}}`, { value: `&<>"'` }))
      .toBe(`&amp;&lt;&gt;&quot;&#39; | &<>"'`);
  });

  test("renders missing values as empty text and preserves whitespace", () => {
    expect(render(" a\n  {{missing}} z ", {})).toBe(" a\n   z ");
  });

  test("supports nested conditions and specified truthiness", () => {
    expect(render("{{#if yes}}A{{#if no}}X{{else}}B{{/if}}{{else}}C{{/if}}", { yes: [], no: true })).toBe("C");
    for (const value of ["", 0, false, null, undefined, []]) {
      expect(render("{{#if value}}yes{{else}}no{{/if}}", { value })).toBe("no");
    }
    expect(render("{{#if value}}yes{{/if}}", { value: {} })).toBe("yes");
  });

  test("iterates nested arrays with item, index, and root fallback", () => {
    const template = "{{#each groups}}[{{name}}/{{title}}:{{#each items}}({{@index}}={{this}}/{{name}}){{else}}empty{{/each}}]{{/each}}";
    const data = {
      title: "root",
      name: "root-name",
      groups: [
        { name: "one", items: ["a", "b"] },
        { name: "two", items: [] },
      ],
    };
    expect(render(template, data)).toBe("[one/root:(0=a/one)(1=b/one)][two/root:empty]");
  });

  test("comments emit nothing", () => {
    expect(render("a{{! ignored }}b", {})).toBe("ab");
  });

  test("rejects non-scalar interpolation", () => {
    expect(() => render("{{item}}", { item: {} })).toThrow("not scalar text");
  });

  test.each([
    ["{{#wat x}}{{/wat}}", "Unknown block", 1, 1],
    ["{{else}}", "Else outside", 1, 1],
    ["{{#if x}}{{else}}{{else}}{{/if}}", "Duplicate else", 1, 18],
    ["{{#if x}}\n{{/each}}", "Mismatched", 2, 1],
    ["x\n{{#each xs}}", "Unclosed each", 2, 1],
  ])("reports structural error for %s", (template, message, line, column) => {
    try {
      render(template, {});
      throw new Error("expected render to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(TemplateError);
      expect((error as Error).message).toContain(message);
      expect(error).toMatchObject({ line, column });
    }
  });
});
