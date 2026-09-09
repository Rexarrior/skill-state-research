import { describe, expect, test } from "bun:test";
import { render } from "../src/engine.ts";

describe("interpolation", () => {
  test("escapes HTML and supports raw values and missing paths", () => {
    expect(render("{{value}}|{{{value}}}|{{missing}}", { value: `&<>\"'` }))
      .toBe("&amp;&lt;&gt;&quot;&#39;|&<>\"'|");
  });

  test("preserves surrounding whitespace and removes comments", () => {
    expect(render(" a \n{{! ignored }}\t b ", {})).toBe(" a \n\t b ");
  });

  test("rejects non-scalar interpolation", () => {
    expect(() => render("first\n{{user}}", { user: { name: "Ada" } }))
      .toThrow("line 2, column 1");
  });
});

describe("blocks", () => {
  test("uses the specified truthiness rules", () => {
    const values = ["", 0, false, null, undefined, []];
    for (const value of values) expect(render("{{#if x}}yes{{else}}no{{/if}}", { x: value })).toBe("no");
    expect(render("{{#if x}}yes{{else}}no{{/if}}", { x: {} })).toBe("yes");
  });

  test("supports nesting", () => {
    const template = "{{#if enabled}}{{#if name}}Hi {{name}}{{else}}anonymous{{/if}}{{/if}}";
    expect(render(template, { enabled: true, name: "Sam" })).toBe("Hi Sam");
  });

  test("iterates arrays with context, root fallback, nesting, and else", () => {
    const template = "{{#each groups}}[{{name}}/{{title}}:{{#each members}}{{@index}}={{this}};{{else}}empty{{/each}}]{{else}}none{{/each}}";
    const data = { title: "Team", groups: [{ name: "A", members: ["x", "y"] }, { name: "B", members: [] }] };
    expect(render(template, data)).toBe("[A/Team:0=x;1=y;][B/Team:empty]");
    expect(render("{{#each items}}x{{else}}none{{/each}}", { items: "not an array" })).toBe("none");
  });
});

describe("structural errors", () => {
  test.each([
    ["{{#wat x}}{{/wat}}", "Unknown block"],
    ["{{else}}", "else outside"],
    ["{{#if x}}{{else}}{{else}}{{/if}}", "Duplicate else"],
    ["{{#if x}}{{/each}}", "Mismatched"],
    ["{{#if x}}", "Unclosed if"],
    ["hello {{name", "Unclosed tag"],
  ])("rejects %s", (template, message) => {
    expect(() => render(template, {})).toThrow(message);
  });
});
