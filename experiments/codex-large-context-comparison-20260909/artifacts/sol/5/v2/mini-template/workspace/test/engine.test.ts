import { describe, expect, test } from "bun:test";
import { render } from "../src/engine";

describe("render", () => {
  test("interpolates escaped and raw scalar values", () => {
    const data = { value: `&<>"'`, count: 0, enabled: false, missing: undefined };
    expect(render("{{value}}|{{{value}}}|{{count}}|{{enabled}}|{{missing}}", data))
      .toBe(`&amp;&lt;&gt;&quot;&#39;|&<>"'|0|false|`);
  });

  test("resolves nested paths and preserves whitespace", () => {
    expect(render("  Hello, {{user.name}}!\n", { user: { name: "Ada" } }))
      .toBe("  Hello, Ada!\n");
  });

  test("supports truthiness, nesting, else, and comments", () => {
    const template = "{{! ignore }}{{#if user}}{{#if user.active}}yes{{else}}no{{/if}}{{else}}none{{/if}}";
    expect(render(template, { user: { active: true } })).toBe("yes");
    expect(render(template, { user: { active: false } })).toBe("no");
    expect(render(template, { user: null })).toBe("none");
    for (const value of ["", 0, false, null, undefined, []]) {
      expect(render("{{#if value}}yes{{else}}no{{/if}}", { value })).toBe("no");
    }
    expect(render("{{#if value}}yes{{/if}}", { value: {} })).toBe("yes");
  });

  test("iterates arrays with locals, root fallback, and nested loops", () => {
    const template = "{{#each groups}}[{{title}}:{{#each members}}{{@index}}={{this}}/{{title}};{{else}}empty{{/each}}]{{else}}none{{/each}}";
    expect(render(template, { title: "root", groups: [
      { title: "A", members: ["x", "y"] },
      { title: "B", members: [] },
    ] })).toBe("[A:0=x/root;1=y/root;][B:empty]");
    expect(render("{{#each items}}{{this}}{{else}}none{{/each}}", { items: [] })).toBe("none");
    expect(render("{{#each items}}x{{else}}none{{/each}}", { items: "no" })).toBe("none");
  });

  test("rejects non-scalar interpolations", () => {
    expect(() => render("{{user}}", { user: {} })).toThrow("not a renderable scalar");
    expect(() => render("{{items}}", { items: [] })).toThrow("not a renderable scalar");
  });

  test("reports structural errors with line and column", () => {
    const cases = [
      ["x\n{{#wat value}}", "Unknown block"],
      ["{{#if ok}}{{/each}}", "Mismatched closing block"],
      ["{{#if ok}}", "Unclosed block"],
      ["{{else}}", "outside a block"],
      ["{{#if ok}}{{else}}{{else}}{{/if}}", "Duplicate"],
      ["{{/if}}", "Unexpected closing block"],
    ];
    for (const [template, message] of cases) {
      expect(() => render(template, {})).toThrow(message);
      expect(() => render(template, {})).toThrow(/line \d+, column \d+/);
    }
  });
});
