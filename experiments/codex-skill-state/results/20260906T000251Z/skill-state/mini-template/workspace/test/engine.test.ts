import { describe, expect, test } from "bun:test";
import { render } from "../src/engine";

describe("interpolation", () => {
  test("escapes HTML and supports raw values and missing paths", () => {
    expect(render("{{value}}|{{{value}}}|{{missing}}", { value: `&<>\"'` }))
      .toBe("&amp;&lt;&gt;&quot;&#39;|&<>\"'|");
  });

  test("rejects non-scalar interpolation", () => {
    expect(() => render("x {{user}}", { user: { name: "Ada" } }))
      .toThrow("Value 'user' cannot be rendered as scalar text at line 1, column 3");
  });
});

describe("blocks", () => {
  test("implements the specified truthiness", () => {
    for (const value of ["", 0, false, null, undefined, []]) {
      expect(render("{{#if value}}yes{{else}}no{{/if}}", { value })).toBe("no");
    }
    for (const value of ["0", 1, true, {}, [0]]) {
      expect(render("{{#if value}}yes{{else}}no{{/if}}", { value })).toBe("yes");
    }
  });

  test("iterates nested arrays with local paths, root fallback, and indices", () => {
    const template = "{{#each groups}}[{{name}}/{{title}}:{{#each this.items}}{{@index}}={{this}};{{else}}empty{{/each}}]{{/each}}";
    expect(render(template, {
      title: "root",
      groups: [{ name: "A", items: ["x", "y"] }, { name: "B", items: [] }],
    })).toBe("[A/root:0=x;1=y;][B/root:empty]");
  });

  test("uses each else for missing, non-array, and empty values", () => {
    expect(render("{{#each xs}}x{{else}}none{{/each}}", { xs: [] })).toBe("none");
    expect(render("{{#each xs}}x{{else}}none{{/each}}", { xs: "no" })).toBe("none");
  });
});

test("comments disappear and whitespace is exact", () => {
  expect(render(" a \n{{! ignore me }}\n b ", {})).toBe(" a \n\n b ");
});

describe("syntax diagnostics", () => {
  test.each([
    ["{{#wat x}}", "Unknown block 'wat' at line 1, column 1"],
    ["a\n{{else}}", "'else' outside a block at line 2, column 1"],
    ["{{#if x}}{{else}}{{else}}{{/if}}", "Duplicate 'else' at line 1, column 18"],
    ["{{#if x}}{{/each}}", "Mismatched closing block 'each'; expected 'if' at line 1, column 10"],
    ["{{/if}}", "Unexpected closing block 'if' at line 1, column 1"],
    ["{{#each xs}}", "Unclosed 'each' block at line 1, column 1"],
    ["hello {{name", "Unclosed tag at line 1, column 7"],
  ])("reports %s", (template, message) => {
    expect(() => render(template, { x: true })).toThrow(message);
  });
});
