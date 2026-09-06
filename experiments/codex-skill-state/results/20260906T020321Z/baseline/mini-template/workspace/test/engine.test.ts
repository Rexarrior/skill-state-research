import { describe, expect, test } from "bun:test";
import { render } from "../src/engine";

describe("render", () => {
  test("interpolates escaped, raw, and missing values", () => {
    const data = { value: `&<>"'`, nested: { count: 0 } };
    expect(render("{{value}}|{{{value}}}|{{nested.count}}|{{missing}}", data))
      .toBe("&amp;&lt;&gt;&quot;&#39;|&<>\"'|0|");
  });

  test("preserves whitespace and removes comments", () => {
    expect(render(" before \n{{! ignored }}\n after ", {})).toBe(" before \n\n after ");
  });

  test("supports nested conditionals and specified truthiness", () => {
    expect(render("{{#if a}}A{{#if b}}B{{else}}C{{/if}}{{else}}D{{/if}}", { a: [], b: true }))
      .toBe("D");
    expect(render("{{#if value}}yes{{else}}no{{/if}}", { value: Number.NaN })).toBe("yes");
  });

  test("iterates nested arrays with local paths, indexes, and root fallback", () => {
    const template = "{{#each groups}}[{{name}}/{{title}}:{{#each items}}{{@index}}={{this}};{{else}}empty{{/each}}]{{else}}none{{/each}}";
    const data = {
      title: "root",
      groups: [
        { name: "one", items: ["a", "b"] },
        { name: "two", items: [] },
      ],
    };
    expect(render(template, data)).toBe("[one/root:0=a;1=b;][two/root:empty]");
  });

  test("uses each else for missing, non-array, and empty values", () => {
    const template = "{{#each value}}item{{else}}empty{{/each}}";
    expect(render(template, {})).toBe("empty");
    expect(render(template, { value: "not an array" })).toBe("empty");
    expect(render(template, { value: [] })).toBe("empty");
  });

  test("renders null and undefined array items as missing this values", () => {
    expect(render("{{#each values}}[{{this}}]{{/each}}", { values: [null, undefined] }))
      .toBe("[][]");
  });

  test("rejects non-scalar interpolations", () => {
    expect(() => render("{{value}}", { value: {} })).toThrow("Cannot render non-scalar value");
    expect(() => render("{{value}}", { value: () => 1 })).toThrow("Cannot render non-scalar value");
  });

  test.each([
    ["{{#wat x}}{{/wat}}", "Unknown block 'wat' at line 1, column 1"],
    ["x\n {{else}}", "'else' used outside a block at line 2, column 2"],
    ["{{#if x}}{{else}}{{else}}{{/if}}", "Duplicate 'else' in block"],
    ["{{#if x}}{{/each}}", "Mismatched closing block"],
    ["{{/if}}", "Closing block 'if' has no opener"],
    ["{{#each xs}}", "Unclosed 'each' block at line 1, column 1"],
    ["{{value", "Unclosed template tag at line 1, column 1"],
  ])("reports structural error for %s", (template, message) => {
    expect(() => render(template, {})).toThrow(message);
  });
});
