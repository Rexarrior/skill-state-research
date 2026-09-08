import { describe, expect, test } from "bun:test";
import { render } from "./engine";

describe("render", () => {
  test("escapes interpolation and preserves raw interpolation", () => {
    const data = { value: `&<>\"'` };
    expect(render("{{value}} {{{value}}}", data)).toBe("&amp;&lt;&gt;&quot;&#39; &<>\"'");
  });

  test("renders missing and null values as empty strings", () => {
    expect(render("a{{missing}}b{{nil}}c", { nil: null })).toBe("abc");
  });

  test("implements the specified truthiness rules", () => {
    for (const value of ["", 0, false, null, undefined, []]) {
      expect(render("{{#if value}}yes{{else}}no{{/if}}", { value })).toBe("no");
    }
    for (const value of ["0", 1, {}, [0]]) {
      expect(render("{{#if value}}yes{{else}}no{{/if}}", { value })).toBe("yes");
    }
  });

  test("supports nested conditionals", () => {
    expect(render("{{#if a}}A{{#if b}}B{{else}}C{{/if}}{{/if}}", { a: true, b: false })).toBe("AC");
  });

  test("iterates arrays with context, index, root fallback, and else", () => {
    const template = "{{#each users}}[{{@index}}:{{name}}/{{site}}/{{this.name}}]{{else}}empty{{/each}}";
    expect(render(template, { site: "HQ", users: [{ name: "Ada" }, { name: "Lin" }] })).toBe(
      "[0:Ada/HQ/Ada][1:Lin/HQ/Lin]",
    );
    expect(render(template, { site: "HQ", users: [] })).toBe("empty");
  });

  test("supports nested loops", () => {
    const template = "{{#each rows}}{{@index}}:{{#each this}}{{@index}}={{this}};{{/each}}|{{/each}}";
    expect(render(template, { rows: [["a", "b"], ["c"]] })).toBe("0:0=a;1=b;|1:0=c;|");
  });

  test("removes comments and preserves surrounding whitespace", () => {
    expect(render(" a \n{{! ignored }}\n b ", {})).toBe(" a \n\n b ");
  });

  test("rejects non-scalar interpolation", () => {
    expect(() => render("{{user}}", { user: { name: "Ada" } })).toThrow(/not scalar text.*line 1, column 1/);
    expect(() => render("{{fn}}", { fn() {} })).toThrow(/not scalar text/);
  });

  test("reports structural mistakes with positions", () => {
    expect(() => render("x\n{{#wat x}}", {})).toThrow(/Unknown block.*line 2, column 1/);
    expect(() => render("{{#if x}}{{else}}{{else}}{{/if}}", {})).toThrow(/Duplicate else.*column 18/);
    expect(() => render("{{else}}", {})).toThrow(/outside.*line 1, column 1/);
    expect(() => render("{{#if x}}{{/each}}", {})).toThrow(/Mismatched.*column 10/);
    expect(() => render("{{#each x}}", {})).toThrow(/Unclosed each.*line 1, column 1/);
    expect(() => render("{{/if}}", {})).toThrow(/no opener/);
  });
});
