import { describe, expect, test } from "bun:test";
import { render } from "../src/engine.ts";

describe("interpolation", () => {
  test("escapes HTML and supports raw values, missing values, and comments", () => {
    const data = { user: { value: `&<>\"'` } };
    expect(render("{{user.value}}|{{{user.value}}}|{{missing}}{{! ignore }}", data))
      .toBe("&amp;&lt;&gt;&quot;&#39;|&<>\"'|");
  });

  test("preserves whitespace exactly", () => {
    expect(render("  hello\n{{name}}  \n", { name: "Ada" })).toBe("  hello\nAda  \n");
  });

  test("renders scalar types", () => {
    expect(render("{{a}}/{{b}}/{{c}}/{{d}}", { a: 12, b: false, c: 3n, d: null }))
      .toBe("12/false/3/");
  });

  test("rejects objects, arrays, functions, and symbols as text", () => {
    for (const value of [{}, [], () => 1, Symbol("x")]) {
      expect(() => render("before {{value}}", { value })).toThrow(/non-scalar.*line 1, column 8/);
    }
  });
});

describe("blocks", () => {
  test("uses the specified truth rules", () => {
    for (const value of ["", 0, -0, false, null, undefined, []]) {
      expect(render("{{#if value}}yes{{else}}no{{/if}}", { value })).toBe("no");
    }
    for (const value of ["0", Number.NaN, {}, [0], true]) {
      expect(render("{{#if value}}yes{{else}}no{{/if}}", { value })).toBe("yes");
    }
  });

  test("supports nested conditionals", () => {
    const template = "{{#if a}}A{{#if b}}B{{else}}C{{/if}}{{else}}D{{/if}}";
    expect(render(template, { a: true, b: false })).toBe("AC");
    expect(render(template, { a: false, b: true })).toBe("D");
  });

  test("iterates arrays with this, index, local paths, and root fallback", () => {
    const template = "{{#each users}}[{{@index}}:{{name}}/{{site}}/{{this.name}}]{{else}}empty{{/each}}";
    const data = { site: "root", users: [{ name: "A" }, { name: "B" }] };
    expect(render(template, data)).toBe("[0:A/root/A][1:B/root/B]");
    expect(render(template, { site: "root", users: [] })).toBe("empty");
    expect(render(template, { site: "root", users: "not an array" })).toBe("empty");
  });

  test("supports nested loops and conditions on current items", () => {
    const template = "{{#each groups}}{{name}}:{{#each items}}{{#if show}}{{@index}}={{this.value}};{{/if}}{{else}}none{{/each}}|{{/each}}";
    const data = {
      groups: [
        { name: "one", items: [{ show: true, value: "x" }, { show: false, value: "y" }] },
        { name: "two", items: [] },
      ],
    };
    expect(render(template, data)).toBe("one:0=x;|two:none|");
  });
});

describe("syntax errors", () => {
  test.each([
    ["{{#wat x}}{{/wat}}", /Unknown block \"wat\" at line 1, column 1/],
    ["x\n{{else}}", /else outside a block at line 2, column 1/],
    ["{{#if x}}{{else}}{{else}}{{/if}}", /Duplicate else at line 1, column 18/],
    ["{{#if x}}{{/each}}", /Mismatched closing block.*line 1, column 10/],
    ["{{/if}}", /without an open block at line 1, column 1/],
    ["a\n{{#each x}}", /Unclosed each block at line 2, column 1/],
    ["{{name", /Unclosed tag at line 1, column 1/],
  ])("reports useful coordinates for %s", (template, expected) => {
    expect(() => render(template, {})).toThrow(expected as RegExp);
  });
});
