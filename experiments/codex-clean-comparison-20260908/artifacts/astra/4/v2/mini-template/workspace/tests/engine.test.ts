import { describe, expect, test } from "bun:test";
import { render } from "../src/engine.ts";

describe("interpolation", () => {
  test("escapes every required character and supports raw values", () => {
    expect(render("{{value}}|{{{value}}}", { value: `&<>"'` })).toBe(`&amp;&lt;&gt;&quot;&#39;|&<>"'`);
  });
  test("preserves whitespace, strips comments and handles scalar and missing values", () => {
    expect(render(" \n{{! ignored }}{{a.b}}\t{{missing}}/{{nil}}/{{zero}}/{{no}}\n", { a: { b: "ok" }, nil: null, zero: 0, no: false })).toBe(" \nok\t//0/false\n");
    expect(render("{{this}}", 42)).toBe("42");
    expect(render("{{a.0}}", { a: ["first"] })).toBe("first");
    expect(render("{{x}}", undefined)).toBe("");
  });
  test("does not expose inherited properties", () => {
    expect(render("{{toString}}/{{secret}}", Object.create({ secret: "hidden" }))).toBe("/");
  });
  test("rejects non-scalars in escaped and raw tags", () => {
    for (const value of [{}, [], () => 1]) {
      for (const tag of ["{{value}}", "{{{value}}}"]) {
        expect(() => render(`x\n ${tag}`, { value })).toThrow(/non-scalar.*line 2, column 2/);
      }
    }
  });
});

describe("blocks", () => {
  test("if truthiness", () => {
    for (const value of ["", 0, false, null, undefined, []]) {
      expect(render("{{#if value}}yes{{else}}no{{/if}}", { value })).toBe("no");
    }
    for (const value of ["0", 1, true, {}, [0], NaN, 0n]) {
      expect(render("{{#if value}}yes{{else}}no{{/if}}", { value })).toBe("yes");
    }
  });
  test("nested if and optional else", () => {
    const template = "{{#if a}}A{{#if b}}B{{else}}C{{/if}}{{else}}D{{/if}}";
    expect(render(template, { a: true, b: false })).toBe("AC");
    expect(render(template, { a: false })).toBe("D");
    expect(render("{{#if missing}}hidden{{/if}}", {})).toBe("");
  });
  test("iteration, local paths and root fallback", () => {
    const template = "{{#each items}}{{@index}}:{{name}}/{{title}}/{{this.name}};{{/each}}";
    expect(render(template, { title: "root", items: [{ name: "A" }, { name: "B", title: "local" }] })).toBe("0:A/root/A;1:B/local/B;");
    expect(render("{{#each items}}[{{this}}]{{/each}}", { items: [0, false, null, "x"] })).toBe("[0][false][][x]");
  });
  test("nested loops restore item and index, and allow nested if", () => {
    const template = "{{#each groups}}{{@index}}/{{name}}:{{#each values}}{{#if this}}{{@index}}={{this}}/{{title}};{{/if}}{{else}}empty {{name}}{{/each}}end{{@index}}/{{name}}|{{/each}}";
    expect(render(template, { title: "R", groups: [{ name: "A", values: ["x", "y"] }, { name: "B", values: [] }] })).toBe("0/A:0=x/R;1=y/R;end0/A|1/B:empty Bend1/B|");
  });
  test("empty and non-array each values use else", () => {
    for (const items of [[], null, undefined, {}, "text", 7]) {
      expect(render("{{#each items}}yes{{else}}no{{/each}}", { items })).toBe("no");
    }
  });
  test("present null/undefined do not fall back; absent nested paths do", () => {
    expect(render("{{#each items}}{{name}}/{{a.b}};{{/each}}", { name: "root", a: { b: "fallback" }, items: [{ name: null }, { name: undefined }, {}] })).toBe("/fallback;/fallback;root/fallback;");
  });
});

describe("syntax errors", () => {
  const cases: [string, RegExp][] = [
    ["{{#wat x}}{{/wat}}", /Unknown block/],
    ["{{#if x}}{{/each}}", /Mismatched closing/],
    ["{{/if}}", /Unexpected closing/],
    ["{{#if x}}", /Unclosed if/],
    ["{{#each x}}{{else}}{{else}}{{/each}}", /Duplicate else/],
    ["{{else}}", /else outside/],
    ["{{value", /Unclosed tag/],
    ["{{{value}}", /Unclosed tag/],
    ["{{#if}}", /Invalid path/],
    ["{{a + b}}", /Invalid path/],
  ];
  for (const [template, message] of cases) {
    test(template, () => {
      expect(() => render(template, {})).toThrow(message);
      expect(() => render(template, {})).toThrow(/line \d+, column \d+/);
    });
  }
  test("accurate multiline location and validation of inactive branches", () => {
    expect(() => render("hello\n  {{else}}", {})).toThrow("line 2, column 3");
    expect(() => render("{{#if missing}}{{#unknown x}}{{/unknown}}{{/if}}", {})).toThrow(/Unknown block/);
  });
});
