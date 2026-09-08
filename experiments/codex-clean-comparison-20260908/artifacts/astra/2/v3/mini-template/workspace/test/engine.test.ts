import { describe, expect, test } from "bun:test";
import { render } from "../src/engine";

describe("interpolation", () => {
  test("escaping, raw text, comments and exact whitespace", () => {
    expect(render(" \n{{value}}|{{{value}}}{{! ignored }}\t\r\n", { value: `&<>"'` }))
      .toBe(" \n&amp;&lt;&gt;&quot;&#39;|&<>\"'\t\r\n");
  });
  test("paths and scalar values", () => {
    expect(render("{{a.b}}/{{missing}}/{{nil}}/{{zero}}/{{no}}/{{big}}", {
      a: { b: "ok" }, nil: null, zero: 0, no: false, big: 12n,
    })).toBe("ok///0/false/12");
    expect(render("{{this}}", "hello")).toBe("hello");
    expect(render("{{this}}", undefined)).toBe("");
    expect(render("{{a.0}}", { a: ["first"] })).toBe("first");
    expect(render("{{inherited}}", Object.create({ inherited: "hidden" }))).toBe("");
  });
  test.each([{}, [], () => "x"].map(value => [value]))("rejects non-scalars", value => {
    expect(() => render("a\n {{value}}", { value })).toThrow(/scalar text.*line 2, column 2/);
    expect(() => render("{{{value}}}", { value })).toThrow(/scalar text/);
  });
});

describe("blocks", () => {
  test.each(["", 0, false, null, undefined, [], -0].map(value => [value]))("false conditions", value => {
    expect(render("{{#if value}}yes{{else}}no{{/if}}", { value })).toBe("no");
  });
  test.each(["0", 1, true, {}, [0], NaN, 0n].map(value => [value]))("true conditions", value => {
    expect(render("{{#if value}}yes{{else}}no{{/if}}", { value })).toBe("yes");
  });
  test("nested if and missing alternate", () => {
    expect(render("{{#if a}}A{{#if b}}B{{else}}C{{/if}}{{else}}D{{/if}}", { a: true, b: false })).toBe("AC");
    expect(render("{{#if x}}x{{/if}}", {})).toBe("");
  });
  test("nested loops, root fallback and context restoration", () => {
    const template = "{{#each groups}}{{@index}}/{{name}}/{{title}}:{{#each items}}{{@index}}={{this}}/{{title}};{{/each}}end{{@index}}/{{name}}|{{/each}}";
    expect(render(template, { title: "ROOT", groups: [{ name: "a", items: ["x", "y"] }, { name: "b", items: ["z"] }] }))
      .toBe("0/a/ROOT:0=x/ROOT;1=y/ROOT;end0/a|1/b/ROOT:0=z/ROOT;end1/b|");
  });
  test("item paths, explicit this, shadowing, conditional context", () => {
    expect(render("{{#each rows}}{{name}}/{{this.name}}/{{deep.x}}/{{#if good}}{{@index}}{{else}}no{{/if}};{{/each}}", {
      name: "root", deep: { x: "fallback" }, rows: [{ name: null, good: true }, { good: false }],
    })).toBe("//fallback/0;root//fallback/no;");
  });
  test.each([[], null, undefined, {}, "text", 3].map(value => [value]))("each alternate", rows => {
    expect(render("{{#each rows}}item{{else}}{{title}}{{/each}}", { rows, title: "empty" })).toBe("empty");
  });
  test("empty nested each keeps surrounding context", () => {
    expect(render("{{#each rows}}{{#each empty}}bad{{else}}{{this.name}}:{{@index}}{{/each}}{{/each}}", { rows: [{ name: "a", empty: [] }] })).toBe("a:0");
  });
});

describe("diagnostics", () => {
  test.each([
    ["{{#wat x}}", "Unknown block"],
    ["{{#if x}}{{/each}}", "Mismatched closing"],
    ["{{/if}}", "Unexpected closing"],
    ["{{#each x}}", "Unclosed each"],
    ["{{#if x}}{{else}}{{else}}{{/if}}", "Duplicate else"],
    ["{{else}}", "else outside"],
    ["{{value", "Unclosed tag"],
    ["{{{value}}", "Unclosed tag"],
    ["{{#if}}", "Invalid path"],
    ["{{a..b}}", "Invalid path"],
  ])("%s", (template, message) => {
    expect(() => render(template, {})).toThrow(message);
    expect(() => render(template, {})).toThrow(/line \d+, column \d+/);
  });
  test("exact source position after tags and newlines", () => {
    expect(() => render("{{x}}\r\n  {{else}}", {})).toThrow("line 2, column 3");
    expect(() => render("{{#if no}}{{#bad x}}{{/if}}", {})).toThrow("Unknown block");
  });
});
