import { describe, expect, test } from "bun:test";
import { render } from "../src/engine";

describe("render", () => {
  test("escaping, raw values, missing values and whitespace", () => {
    expect(render(' \n{{ x }}|{{{x}}}|{{missing}}|{{nil}}\t', { x: '&<>"\'', nil: null }))
      .toBe(' \n&amp;&lt;&gt;&quot;&#39;|&<>"\'| |\t'.replace('| |', '||'));
    expect(render("{{a.b}} {{a.c}} {{a.d}}", { a: { b: 0, c: false, d: 42 } })).toBe("0 false 42");
    expect(render("{{this}}", "root")).toBe("root");
  });
  test("truthiness", () => {
    for (const value of ["", 0, false, null, undefined, [], NaN]) {
      expect(render("{{#if x}}yes{{else}}no{{/if}}", { x: value })).toBe("no");
    }
    for (const value of ["0", 1, true, {}, [0]]) {
      expect(render("{{#if x}}yes{{else}}no{{/if}}", { x: value })).toBe("yes");
    }
  });
  test("nested conditionals and comments", () => {
    expect(render("A{{! ignored }}{{#if a}}B{{#if b}}C{{else}}D{{/if}}{{else}}E{{/if}}F", { a: true, b: false })).toBe("ABDF");
  });
  test("nested loops, root fallback and restored context", () => {
    const template = "{{#each groups}}{{@index}}/{{name}}/{{title}}:{{#each items}}{{@index}}={{this}}/{{title}};{{else}}none{{/each}}({{@index}}/{{name}}){{/each}}";
    expect(render(template, { title: "R", groups: [{ name: "A", items: ["x", "y"] }, { name: "B", items: [] }] }))
      .toBe("0/A/R:0=x/R;1=y/R;(0/A)1/B/R:none(1/B)");
  });
  test("local missing paths fall back but existing undefined does not", () => {
    expect(render("{{#each xs}}{{a.b}}|{{x}}|{{this.x}}{{/each}}", { a: { b: "root" }, x: "root", xs: [{ a: {}, x: undefined }] })).toBe("root||");
    expect(render("{{#each xs}}{{this}};{{/each}}", { xs: [0, false, null] })).toBe("0;false;;");
  });
  test("empty and non-array loops", () => {
    for (const xs of [[], null, undefined, {}, "abc", 1]) {
      expect(render("{{#each xs}}x{{else}}empty{{/each}}", { xs })).toBe("empty");
      expect(render("{{#each xs}}x{{/each}}", { xs })).toBe("");
    }
  });
  test("only own properties resolve", () => {
    expect(render("{{inherited}}/{{constructor}}", Object.create({ inherited: "bad" }))).toBe("/");
  });
  test("non-scalars fail for escaped and raw tags", () => {
    for (const x of [{}, [], () => 1]) {
      for (const tag of ["{{x}}", "{{{x}}}"]) expect(() => render(tag, { x })).toThrow(/scalar.*line 1, column 1/);
    }
  });
  test("structural errors include locations", () => {
    for (const [template, message] of [
      ["{{#wat x}}", "Unknown block"], ["{{/if}}", "Unexpected closing"],
      ["{{#if x}}{{/each}}", "Mismatched closing"], ["{{#each x}}", "Unclosed each"],
      ["{{#if x}}{{else}}{{else}}{{/if}}", "Duplicate else"], ["{{else}}", "else outside"],
      ["{{x", "Unclosed tag"], ["{{#if}}", "Invalid path"],
      ["{{#if x}}{{#wat y}}{{/if}}", "Unknown block"],
    ]) {
      expect(() => render(template!, {})).toThrow(message!);
      expect(() => render(template!, {})).toThrow(/line \d+, column \d+/);
    }
    expect(() => render("first\n  {{else}}", {})).toThrow("line 2, column 3");
  });
});
