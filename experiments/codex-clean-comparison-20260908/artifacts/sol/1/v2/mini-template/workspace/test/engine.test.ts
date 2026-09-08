import { describe, expect, test } from "bun:test";
import { render } from "../src/engine";

describe("interpolation", () => {
  test("escapes HTML and supports raw values", () => {
    const data = { value: `&<>"'` };
    expect(render("{{value}}|{{{value}}}", data)).toBe("&amp;&lt;&gt;&quot;&#39;|&<>\"'");
  });

  test("resolves dotted paths and empties missing/null values", () => {
    expect(render("{{user.name}}/{{missing}}/{{nil}}", { user: { name: "Ada" }, nil: null }))
      .toBe("Ada//");
  });

  test("rejects values that are not scalar text", () => {
    expect(() => render("before {{user}}", { user: { name: "Ada" } }))
      .toThrow(/cannot be rendered as scalar text.*line 1, column 8/);
    expect(() => render("{{fn}}", { fn: () => 1 })).toThrow(/cannot be rendered/);
  });

  test("preserves whitespace and removes comments", () => {
    expect(render(" a\n {{! ignore me }} \t b ", {})).toBe(" a\n  \t b ");
  });
});

describe("blocks", () => {
  test("implements the specified truthiness rules", () => {
    for (const value of ["", 0, -0, 0n, false, null, undefined, []]) {
      expect(render("{{#if value}}yes{{else}}no{{/if}}", { value })).toBe("no");
    }
    for (const value of ["0", 1, true, {}, [0], Number.NaN]) {
      expect(render("{{#if value}}yes{{else}}no{{/if}}", { value })).toBe("yes");
    }
  });

  test("supports nested conditionals", () => {
    const template = "{{#if outer}}A{{#if inner}}B{{else}}C{{/if}}D{{else}}E{{/if}}";
    expect(render(template, { outer: true, inner: false })).toBe("ACD");
    expect(render(template, { outer: false, inner: true })).toBe("E");
  });

  test("iterates arrays with item, index, and root fallback", () => {
    const template = "{{#each users}}[{{@index}}:{{name}}/{{site}}]{{else}}empty{{/each}}";
    expect(render(template, { site: "HQ", users: [{ name: "A" }, { name: "B" }] }))
      .toBe("[0:A/HQ][1:B/HQ]");
    expect(render(template, { site: "HQ", users: [] })).toBe("empty");
    expect(render(template, { site: "HQ", users: "not an array" })).toBe("empty");
  });

  test("supports primitive items and nested loops", () => {
    const template = "{{#each groups}}{{name}}={{#each this.items}}{{@index}}:{{this}}/{{name}};{{/each}}{{/each}}";
    const data = { name: "root", groups: [{ name: "G", items: ["x", "y"] }] };
    expect(render(template, data)).toBe("G=0:x/G;1:y/G;");
  });
});

describe("syntax errors", () => {
  test.each([
    ["{{#wat x}}", /Unknown block "wat".*line 1, column 1/],
    ["x\n{{/if}}", /Closing if without an open block.*line 2, column 1/],
    ["{{#if x}}{{/each}}", /Mismatched closing block.*line 1, column 10/],
    ["{{#if x}}", /Unclosed if block.*line 1, column 1/],
    ["{{else}}", /else used outside a block.*line 1, column 1/],
    ["{{#if x}}{{else}}{{else}}{{/if}}", /Duplicate else.*line 1, column 18/],
    ["hello {{name", /Unclosed tag.*line 1, column 7/],
  ])("reports useful locations for %s", (template, expected) => {
    expect(() => render(template, { x: true })).toThrow(expected);
  });
});
