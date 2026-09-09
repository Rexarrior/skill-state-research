import { describe, expect, test } from "bun:test";
import { render } from "../src/engine";

describe("render", () => {
  test("escapes interpolation and leaves triple interpolation raw", () => {
    const value = `&<>\"'`;
    expect(render("{{value}} | {{{value}}}", { value })).toBe(
      "&amp;&lt;&gt;&quot;&#39; | &<>\"'",
    );
  });

  test("renders missing values as empty strings", () => {
    expect(render("a{{missing.deep}}b", {})).toBe("ab");
  });

  test("handles if truthiness and nested branches", () => {
    const template = "{{#if items}}yes {{#if enabled}}on{{else}}off{{/if}}{{else}}none{{/if}}";
    expect(render(template, { items: [1], enabled: false })).toBe("yes off");
    expect(render(template, { items: [], enabled: true })).toBe("none");
    expect(render("{{#if n}}yes{{else}}no{{/if}}", { n: 0 })).toBe("no");
  });

  test("iterates, exposes context, and falls back to root", () => {
    const template = "{{#each users}}[{{@index}} {{name}}/{{site}}/{{this.name}}]{{else}}empty{{/each}}";
    expect(render(template, { site: "HQ", users: [{ name: "Ada" }, { name: "Lin" }] })).toBe(
      "[0 Ada/HQ/Ada][1 Lin/HQ/Lin]",
    );
    expect(render(template, { site: "HQ", users: [] })).toBe("empty");
  });

  test("supports nested loops", () => {
    const template = "{{#each rows}}{{#each this}}{{@index}}={{this}};{{/each}}|{{/each}}";
    expect(render(template, { rows: [["a", "b"], ["c"]] })).toBe("0=a;1=b;|0=c;|");
  });

  test("removes comments while preserving surrounding whitespace", () => {
    expect(render(" a \n{{! ignored }}\n b ", {})).toBe(" a \n\n b ");
  });

  test("rejects structural errors with locations", () => {
    expect(() => render("x\n{{else}}", {})).toThrow("line 2, column 1");
    expect(() => render("{{#if a}}{{else}}{{else}}{{/if}}", {})).toThrow("Duplicate else");
    expect(() => render("{{#if a}}{{/each}}", {})).toThrow("Mismatched closing block");
    expect(() => render("{{#wat a}}{{/wat}}", {})).toThrow("Unknown block");
    expect(() => render("{{#each a}}", {})).toThrow("Unclosed");
  });

  test("rejects non-scalar interpolation", () => {
    expect(() => render("{{user}}", { user: { name: "Ada" } })).toThrow(
      'Cannot render an object at path "user"',
    );
  });
});
