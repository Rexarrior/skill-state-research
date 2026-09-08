import { describe, expect, test } from "bun:test";
import { render } from "../src/engine.ts";

describe("render", () => {
  test("interpolates escaped and raw scalar values", () => {
    const data = { value: `&<>\"'`, count: 0, nope: null };
    expect(render("{{value}}|{{{value}}}|{{count}}|{{nope}}|{{missing}}", data))
      .toBe("&amp;&lt;&gt;&quot;&#39;|&<>\"'|0||");
  });

  test("preserves whitespace and removes comments", () => {
    expect(render(" a \n{{! ignored }}\n b ", {})).toBe(" a \n\n b ");
  });

  test("handles if truthiness, else, and nesting", () => {
    expect(render("{{#if users}}yes {{#if enabled}}on{{else}}off{{/if}}{{else}}none{{/if}}", {
      users: [1], enabled: false,
    })).toBe("yes off");
    for (const falseValue of ["", 0, false, null, undefined, []]) {
      expect(render("{{#if value}}yes{{else}}no{{/if}}", { value: falseValue })).toBe("no");
    }
    expect(render("{{#if value}}yes{{else}}no{{/if}}", { value: {} })).toBe("yes");
  });

  test("iterates arrays with local values, root fallback, index, and else", () => {
    const template = "{{#each users}}[{{@index}}:{{name}}/{{site}}]{{else}}empty{{/each}}";
    expect(render(template, { site: "HQ", users: [{ name: "Ada" }, { name: "Lin" }] }))
      .toBe("[0:Ada/HQ][1:Lin/HQ]");
    expect(render(template, { site: "HQ", users: [] })).toBe("empty");
    expect(render(template, { site: "HQ", users: "not an array" })).toBe("empty");
  });

  test("supports nested loops and explicit this paths", () => {
    const template = "{{#each groups}}{{this.name}}={{#each items}}{{@index}}:{{this}};{{else}}-{{/each}}|{{/each}}";
    expect(render(template, { groups: [{ name: "a", items: ["x", "y"] }, { name: "b", items: [] }] }))
      .toBe("a=0:x;1:y;|b=-|");
  });

  test("rejects non-scalar interpolations", () => {
    expect(() => render("x {{user}}", { user: { name: "Ada" } }))
      .toThrow(/cannot be rendered.*line 1, column 3/);
  });

  test.each([
    ["{{#wat x}}{{/wat}}", /Unknown block.*line 1, column 1/],
    ["{{/if}}", /without an open block.*line 1, column 1/],
    ["{{#if x}}\n{{/each}}", /expected \/if, got \/each.*line 2, column 1/],
    ["{{#if x}}", /Unclosed if block.*line 1, column 1/],
    ["{{else}}", /else outside.*line 1, column 1/],
    ["{{#if x}}{{else}}{{else}}{{/if}}", /Duplicate else.*column 18/],
    ["before {{name", /Unclosed tag.*line 1, column 8/],
  ])("reports structural error for %s", (template, expected) => {
    expect(() => render(template, {})).toThrow(expected);
  });
});
