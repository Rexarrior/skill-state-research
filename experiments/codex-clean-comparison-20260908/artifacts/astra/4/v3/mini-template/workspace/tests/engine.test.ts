import { describe, expect, test } from "bun:test";
import { render } from "../src/engine";

describe("interpolation", () => {
  test("escapes all five characters and leaves raw values intact", () => {
    expect(render("{{x}}|{{{x}}}", { x: `&<>"'` })).toBe(`&amp;&lt;&gt;&quot;&#39;|&<>"'`);
  });
  test("preserves whitespace and handles missing values, comments, and scalars", () => {
    expect(render(" \n{{! ignored }}{{missing.x}}\t{{a}}/{{b}}/{{c}}/{{d}}\r\n", {
      a: 0, b: false, c: null, d: 12n,
    })).toBe(" \n\t0/false//12\r\n");
    expect(render("{{this}}", "hello")).toBe("hello");
    expect(render("{{this}}", undefined)).toBe("");
    expect(render("", {})).toBe("");
  });
  test("uses own properties and numeric indices", () => {
    const value = Object.assign(Object.create({ inherited: "secret" }), { rows: ["a", "b"] });
    expect(render("{{inherited}}{{constructor}}{{rows.1}}", value)).toBe("b");
  });
  for (const value of [{}, [], () => 1, Symbol("x")]) {
    test(`rejects non-scalar ${typeof value}`, () => {
      expect(() => render("\n{{x}}", { x: value })).toThrow(/scalar text.*line 2, column 1/);
      expect(() => render("{{{x}}}", { x: value })).toThrow("scalar text");
    });
  }
});

describe("blocks and context", () => {
  test("if truthiness", () => {
    for (const value of ["", 0, false, null, undefined, [], 0n]) {
      expect(render("{{#if x}}yes{{else}}no{{/if}}", { x: value })).toBe("no");
    }
    for (const value of ["0", 1, true, {}, [0], NaN]) {
      expect(render("{{#if x}}yes{{else}}no{{/if}}", { x: value })).toBe("yes");
    }
  });
  test("nested branches", () => {
    expect(render("{{#if a}}A{{#if b}}B{{else}}C{{/if}}{{else}}D{{/if}}", { a: true, b: false })).toBe("AC");
    expect(render("{{#if a}}A{{else}}{{#if b}}B{{else}}C{{/if}}{{/if}}", { b: true })).toBe("B");
  });
  test("nested loops restore context and resolve root fallbacks", () => {
    const template = "{{#each groups}}[{{@index}}:{{name}}:{{title}}{{#each this.items}}({{@index}}={{this}}/{{title}}){{/each}}:{{@index}}:{{name}}]{{/each}}";
    expect(render(template, { title: "root", groups: [{ name: "A", items: ["x", "y"] }, { name: "B", items: ["z"] }] }))
      .toBe("[0:A:root(0=x/root)(1=y/root):0:A][1:B:root(0=z/root):1:B]");
  });
  test("item properties shadow root, explicit this never falls back", () => {
    expect(render("{{#each items}}{{name}}/{{user.name}}/{{this.title}}/{{title}};{{/each}}", {
      name: "root", title: "T", user: { name: "root user" }, items: [{ name: "local", user: {} }, null],
    })).toBe("local///T;root/root user//T;");
  });
  test("each else preserves outer context, including index", () => {
    expect(render("{{#each items}}{{#each this.empty}}bad{{else}}{{@index}}:{{name}}{{/each}}{{/each}}", {
      items: [{ name: "A", empty: [] }],
    })).toBe("0:A");
    for (const value of [[], undefined, null, false, "abc", {}]) {
      expect(render("{{#each x}}bad{{else}}empty{{/each}}", { x: value })).toBe("empty");
      expect(render("{{#each x}}bad{{/each}}", { x: value })).toBe("");
    }
  });
});

describe("syntax errors", () => {
  for (const [source, error] of [
    ["{{#unknown x}}", "Unknown block"],
    ["{{#if x}}{{/each}}", "Mismatched closing tag"],
    ["{{/if}}", "Unexpected closing tag"],
    ["{{#each x}}", "Unclosed each block"],
    ["{{#if x}}{{else}}{{else}}{{/if}}", "Duplicate else"],
    ["{{else}}", "else outside a block"],
    ["{{x", "Unclosed tag"],
    ["{{{x}}", "Unclosed tag"],
    ["{{#if}}", "Invalid path"],
    ["{{a..b}}", "Invalid path"],
    ["{{#if x}}{{#bad y}}{{/bad}}{{/if}}", "Unknown block"],
  ]) {
    test(source!, () => {
      expect(() => render(source!, {})).toThrow(error!);
      expect(() => render(source!, {})).toThrow(/line \d+, column \d+/);
    });
  }
  test("precise position with CRLF and multiline text", () => {
    expect(() => render("one\r\ntwo\n  {{else}}", {})).toThrow("line 3, column 3");
  });
});
