import { describe, expect, test } from "bun:test";
import { render } from "../src/engine";

describe("interpolation", () => {
  test("escapes HTML and supports raw and missing values", () => {
    expect(render(`{{value}}|{{{value}}}|{{missing}}`, { value: `&<>"'` }))
      .toBe(`&amp;&lt;&gt;&quot;&#39;|&<>"'|`);
  });

  test("resolves nested own properties", () => {
    expect(render("Hello, {{user.name}}!", { user: { name: "Ada" } }))
      .toBe("Hello, Ada!");
    expect(render("{{toString}}", {})).toBe("");
  });

  test("rejects non-scalar values with a source location", () => {
    expect(() => render("x\n{{user}}", { user: { name: "Ada" } }))
      .toThrow("Value 'user' cannot be rendered as scalar text at line 2, column 1");
  });
});

describe("blocks", () => {
  test("if uses the specified truthiness rules", () => {
    for (const value of ["", 0, false, null, undefined, []]) {
      expect(render("{{#if x}}yes{{else}}no{{/if}}", { x: value })).toBe("no");
    }
    for (const value of ["0", true, {}, [0]]) {
      expect(render("{{#if x}}yes{{else}}no{{/if}}", { x: value })).toBe("yes");
    }
  });

  test("each exposes item/index, falls back to root, and nests", () => {
    const template = "{{#each groups}}[{{name}}/{{title}}:{{#each members}}{{@index}}={{this}};{{else}}empty{{/each}}]{{/each}}";
    const data = {
      title: "team",
      groups: [
        { name: "A", members: ["x", "y"] },
        { name: "B", members: [] },
      ],
    };
    expect(render(template, data)).toBe("[A/team:0=x;1=y;][B/team:empty]");
  });

  test("each else handles missing, empty, and non-array values", () => {
    expect(render("{{#each x}}item{{else}}none{{/each}}", { x: [] })).toBe("none");
    expect(render("{{#each x}}item{{else}}none{{/each}}", {})).toBe("none");
    expect(render("{{#each x}}item{{else}}none{{/each}}", { x: "no" })).toBe("none");
  });

  test("comments disappear and whitespace is exact", () => {
    expect(render(" a \n{{! ignore me }}\t b ", {})).toBe(" a \n\t b ");
  });
});

describe("syntax errors", () => {
  test.each([
    ["{{else}}", "'else' outside a block at line 1, column 1"],
    ["{{#if x}}{{else}}{{else}}{{/if}}", "Duplicate 'else' at line 1, column 18"],
    ["{{#wat x}}{{/wat}}", "Unknown block 'wat' at line 1, column 1"],
    ["{{#if x}}{{/each}}", "Mismatched closing block: expected '/if', got '/each' at line 1, column 10"],
    ["{{#if x}}", "Unclosed 'if' block at line 1, column 1"],
    ["line\n{{value", "Unclosed tag at line 2, column 1"],
  ])("reports %s", (template, message) => {
    expect(() => render(template, {})).toThrow(message);
  });
});
