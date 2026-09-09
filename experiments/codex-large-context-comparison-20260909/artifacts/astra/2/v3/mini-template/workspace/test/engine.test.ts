import { describe, expect, test } from "bun:test";
import { render } from "../src/engine";

describe("render", () => {
  test("escaping, raw values, scalars and whitespace", () => {
    expect(render(" \n{{ text }}|{{{text}}}|{{n}}|{{f}}\t", { text: `&<>"'`, n: 0, f: false }))
      .toBe(" \n&amp;&lt;&gt;&quot;&#39;|&<>\"'|0|false\t");
    expect(render("{{a}}/{{b}}/{{x.y}}", { a: null, b: undefined })).toBe("//");
    expect(render("{{this}}", 12)).toBe("12");
    expect(render("{{this}}", 2n)).toBe("2");
    expect(render("", null)).toBe("");
  });
  test("comments and untouched literal whitespace", () => {
    expect(render("a\r\n {{! ignored }} \t b\n", {})).toBe("a\r\n  \t b\n");
  });
  test("truthiness and nested conditionals", () => {
    for (const value of ["", 0, false, null, undefined, [], NaN]) {
      expect(render("{{#if v}}T{{else}}F{{/if}}", { v: value })).toBe("F");
    }
    for (const value of ["0", 1, true, {}, [0]]) {
      expect(render("{{#if v}}T{{else}}F{{/if}}", { v: value })).toBe("T");
    }
    expect(render("{{#if a}}A{{#if b}}B{{else}}C{{/if}}{{else}}D{{/if}}", { a: true, b: false })).toBe("AC");
  });
  test("each, root fallback, nested indices, context restoration", () => {
    const template = "{{#each groups}}{{@index}}={{name}}/{{title}}[{{#each items}}{{@index}}:{{this}}/{{title}};{{else}}empty{{/each}}]{{@index}};{{/each}}";
    expect(render(template, { title: "R", groups: [{ name: "A", items: ["x", "y"] }, { name: "B", items: [] }] }))
      .toBe("0=A/R[0:x/R;1:y/R;]0;1=B/R[empty]1;");
    expect(render("{{#each v}}{{this}}{{else}}empty{{/each}}", { v: {} })).toBe("empty");
    expect(render("{{#each missing}}x{{else}}empty{{/each}}", {})).toBe("empty");
    expect(render("{{@index}}", {})).toBe("");
  });
  test("own paths, array indices, explicit missing values and fallback", () => {
    expect(render("{{a.0.x}}/{{toString}}", { a: [{ x: "yes" }] })).toBe("yes/");
    expect(render("{{#each list}}{{name}}:{{this.name}};{{/each}}", { name: "root", list: [{ name: null }, {}, { name: undefined }] })).toBe(":;root:;:;");
    expect(render("{{inherited}}", Object.create({ inherited: "no" }))).toBe("");
  });
  test("non-scalar interpolations fail clearly", () => {
    for (const value of [{}, [], () => 1]) {
      for (const template of ["{{v}}", "{{{v}}}"]) {
        expect(() => render(template, { v: value })).toThrow(/non-scalar.*v.*line 1, column 1/);
      }
    }
    expect(render("{{#if no}}{{bad}}{{/if}}", { bad: {} })).toBe("");
  });
  test("structural errors include locations", () => {
    for (const [template, message] of [
      ["{{#unknown x}}", "Unknown block"],
      ["{{/if}}", "Unexpected closing"],
      ["{{#if x}}{{/each}}", "Mismatched closing"],
      ["{{#if x}}", "Unclosed if"],
      ["{{#each x}}", "Unclosed each"],
      ["{{#if x}}{{else}}{{else}}{{/if}}", "Duplicate else"],
      ["{{else}}", "else outside"],
      ["{{unfinished", "Unclosed tag"],
      ["{{#if }}", "Invalid path"],
      ["{{}}", "Invalid path"],
      ["{{#if no}}{{#wat x}}{{/wat}}{{/if}}", "Unknown block"],
    ]) {
      expect(() => render(template, {})).toThrow(message);
      expect(() => render(template, {})).toThrow(/line \d+, column \d+/);
    }
    expect(() => render("one\n  {{else}}", {})).toThrow("line 2, column 3");
    expect(() => render("one\r\n  {{else}}", {})).toThrow("line 2, column 3");
  });
});
