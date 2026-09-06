import { describe, expect, test } from "bun:test";
import { render } from "../src/engine";

describe("render", () => {
  test("escapes interpolation and leaves triple interpolation raw", () => {
    const value = `&<>"'`;
    expect(render("{{value}}|{{{value}}}", { value })).toBe("&amp;&lt;&gt;&quot;&#39;|&<>\"'");
  });

  test("preserves whitespace, removes comments, and empties missing values", () => {
    expect(render(" a \n{{! ignored }}\n{{missing}} z ", {})).toBe(" a \n\n z ");
  });

  test("implements the specified truthiness", () => {
    for (const value of ["", 0, false, null, undefined, []]) {
      expect(render("{{#if value}}yes{{else}}no{{/if}}", { value })).toBe("no");
    }
    for (const value of ["0", 1, true, {}, [0]]) {
      expect(render("{{#if value}}yes{{else}}no{{/if}}", { value })).toBe("yes");
    }
  });

  test("supports nested conditions", () => {
    const template = "{{#if outer}}A{{#if inner}}B{{else}}C{{/if}}D{{else}}E{{/if}}";
    expect(render(template, { outer: true, inner: false })).toBe("ACD");
    expect(render(template, { outer: false, inner: true })).toBe("E");
  });

  test("iterates arrays with this, index, local paths, and root fallback", () => {
    const template = "{{#each users}}[{{@index}}:{{name}}/{{site}}/{{this.name}}]{{else}}empty{{/each}}";
    expect(render(template, { site: "HQ", users: [{ name: "Ada" }, { name: "Lin" }] })).toBe(
      "[0:Ada/HQ/Ada][1:Lin/HQ/Lin]",
    );
    expect(render(template, { site: "HQ", users: [] })).toBe("empty");
    expect(render(template, { site: "HQ", users: "no" })).toBe("empty");
  });

  test("supports nested loops", () => {
    const template = "{{#each rows}}{{@index}}={{#each this}}{{@index}}:{{this}};{{/each}}|{{/each}}";
    expect(render(template, { rows: [["a", "b"], ["c"]] })).toBe("0=0:a;1:b;|1=0:c;|");
  });

  test("rejects non-scalar interpolation", () => {
    expect(() => render("before {{value}}", { value: {} })).toThrow(/cannot be rendered as scalar text.*line 1, column 8/);
    expect(() => render("{{value}}", { value: Symbol("x") })).toThrow(/received symbol/);
  });

  test("reports structural errors with line and column", () => {
    expect(() => render("x\n{{#wat value}}", {})).toThrow(/Unknown or malformed block 'wat'.*line 2, column 1/);
    expect(() => render("{{#if x}}{{else}}{{else}}{{/if}}", {})).toThrow(/Duplicate 'else'.*line 1, column 18/);
    expect(() => render(" {{else}}", {})).toThrow(/outside a block.*line 1, column 2/);
    expect(() => render("{{#if x}}{{/each}}", {})).toThrow(/Mismatched closing block 'each'; expected 'if'/);
    expect(() => render("{{/if}}", {})).toThrow(/without an open block/);
    expect(() => render("\n{{#each x}}", {})).toThrow(/Unclosed 'each' block.*line 2, column 1/);
    expect(() => render("abc {{name", {})).toThrow(/Unclosed template tag.*line 1, column 5/);
  });
});
