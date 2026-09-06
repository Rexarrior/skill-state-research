import { describe, expect, test } from "bun:test";
import { render } from "../src/engine.ts";

describe("render", () => {
  test("interpolates escaped and raw scalar values", () => {
    const data = { value: `&<>"'`, raw: "<b>ok</b>", missing: undefined };
    expect(render("{{value}}|{{{raw}}}|{{missing}}|{{nope}}", data))
      .toBe("&amp;&lt;&gt;&quot;&#39;|<b>ok</b>||");
  });

  test("supports nested conditionals and exact whitespace", () => {
    const template = " A {{#if yes}}Y{{#if no}}N{{else}}!{{/if}}{{else}}X{{/if}} B\n";
    expect(render(template, { yes: true, no: false })).toBe(" A Y! B\n");
  });

  test("uses the specified truthiness rules", () => {
    for (const value of ["", 0, false, null, undefined, []]) {
      expect(render("{{#if value}}yes{{else}}no{{/if}}", { value })).toBe("no");
    }
    expect(render("{{#if value}}yes{{/if}}", { value: {} })).toBe("yes");
  });

  test("iterates nested arrays with context, index, and root fallback", () => {
    const template = "{{#each rows}}[{{@index}}:{{name}}/{{title}}:{{#each values}}{{@index}}={{this}};{{else}}empty{{/each}}]{{/each}}";
    const data = { title: "T", rows: [{ name: "a", values: [3, 4] }, { name: "b", values: [] }] };
    expect(render(template, data)).toBe("[0:a/T:0=3;1=4;][1:b/T:empty]");
  });

  test("comments emit nothing", () => {
    expect(render("a{{! ignored }}b", {})).toBe("ab");
  });

  test("rejects structural mistakes with locations", () => {
    const invalid = [
      "{{else}}",
      "{{#if x}}{{else}}{{else}}{{/if}}",
      "{{#if x}}{{/each}}",
      "{{#wat x}}{{/wat}}",
      "first\n{{#if x}}",
    ];
    for (const template of invalid) expect(() => render(template, {})).toThrow(/line \d+, column \d+/);
  });

  test("rejects non-scalar interpolation", () => {
    expect(() => render("value={{value}}", { value: { x: 1 } })).toThrow(/non-scalar.*line 1, column 7/);
  });
});
