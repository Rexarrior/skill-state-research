import { describe, expect, test } from "bun:test";
import { render } from "../src/engine";

describe("render", () => {
  test("escapes interpolation and preserves raw interpolation", () => {
    const data = { value: `&<>"'` };
    expect(render("{{value}}|{{{value}}}", data)).toBe("&amp;&lt;&gt;&quot;&#39;|&<>\"'");
  });

  test("resolves nested paths and renders missing values as empty", () => {
    expect(render("Hi {{user.name}} [{{missing}}]", { user: { name: "Ada" } })).toBe("Hi Ada []");
  });

  test("handles if truthiness, else, and nesting", () => {
    const template = "{{#if user}}{{#if user.active}}yes{{else}}no{{/if}}{{else}}none{{/if}}";
    expect(render(template, { user: { active: true } })).toBe("yes");
    expect(render(template, { user: { active: false } })).toBe("no");
    expect(render(template, { user: null })).toBe("none");
    for (const value of ["", 0, false, null, undefined, []]) {
      expect(render("{{#if value}}T{{else}}F{{/if}}", { value })).toBe("F");
    }
  });

  test("iterates arrays with local paths, root fallback, index, and nested loops", () => {
    const template = "{{#each groups}}[{{name}}/{{title}}:{{#each items}}{{@index}}={{this}};{{else}}empty{{/each}}]{{/each}}";
    const data = {
      title: "root",
      groups: [
        { name: "A", items: ["x", "y"] },
        { name: "B", items: [] },
      ],
    };
    expect(render(template, data)).toBe("[A/root:0=x;1=y;][B/root:empty]");
  });

  test("each else handles missing and non-array values", () => {
    expect(render("{{#each items}}x{{else}}empty{{/each}}", {})).toBe("empty");
    expect(render("{{#each items}}x{{else}}empty{{/each}}", { items: "no" })).toBe("empty");
  });

  test("removes comments while preserving surrounding whitespace", () => {
    expect(render(" a \n{{! ignored }}\n b ", {})).toBe(" a \n\n b ");
  });

  test("rejects structural errors with line and column", () => {
    expect(() => render("x\n{{else}}", {})).toThrow("else outside a block at line 2, column 1");
    expect(() => render("{{#if x}}{{else}}{{else}}{{/if}}", {})).toThrow("Duplicate else");
    expect(() => render("{{#if x}}{{/each}}", {})).toThrow("Mismatched closing block");
    expect(() => render("{{#wat x}}{{/wat}}", {})).toThrow("Unknown block 'wat'");
    expect(() => render("{{#each x}}", {})).toThrow("Unclosed 'each' block");
  });

  test("rejects non-scalar interpolation", () => {
    expect(() => render("{{user}}", { user: { name: "Ada" } })).toThrow("not scalar");
    expect(() => render("{{items}}", { items: [] })).toThrow("not scalar");
  });
});
