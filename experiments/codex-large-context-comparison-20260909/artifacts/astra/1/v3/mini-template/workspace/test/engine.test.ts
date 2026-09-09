import { describe, expect, test } from "bun:test";
import { render } from "../src/engine.ts";

describe("render", () => {
  test("preserves text and whitespace and removes comments", () => {
    expect(render(" \r\n A\t{{! comment }} B\n", {})).toBe(" \r\n A\t B\n");
    expect(render("", null)).toBe("");
  });
  test("escapes all HTML characters and supports raw interpolation", () => {
    expect(render("{{ value }}|{{{value}}}", { value: `&<>"'` })).toBe(`&amp;&lt;&gt;&quot;&#39;|&<>"'`);
  });
  test("resolves own paths, missing values, and scalars", () => {
    expect(render("{{a.b.0}}|{{missing.x}}|{{nil}}|{{false}}|{{zero}}", {
      a: { b: ["ok"] }, nil: null, false: false, zero: 0,
    })).toBe("ok|||false|0");
    expect(render("{{toString}}|{{constructor}}", {})).toBe("|");
    expect(render("{{this}}", 12n)).toBe("12");
  });
  test("if truthiness and nesting", () => {
    for (const x of ["", 0, false, null, undefined, [], NaN]) {
      expect(render("{{#if x}}yes{{else}}no{{/if}}", { x })).toBe("no");
    }
    for (const x of ["0", 1, true, {}, [0]]) {
      expect(render("{{#if x}}yes{{else}}no{{/if}}", { x })).toBe("yes");
    }
    expect(render("{{#if a}}A{{#if b}}B{{else}}C{{/if}}{{else}}D{{/if}}", { a: true })).toBe("AC");
  });
  test("each has root fallback and nested context restoration", () => {
    const template = "{{#each groups}}[{{@index}}/{{name}}/{{title}}:{{#each items}}{{@index}}={{this}};{{else}}none{{/each}}/{{@index}}/{{name}}]{{/each}}";
    expect(render(template, { title: "Root", groups: [
      { name: "A", items: ["x", "y"] }, { name: "B", items: [] },
    ] })).toBe("[0/A/Root:0=x;1=y;/0/A][1/B/Root:none/1/B]");
    expect(render("{{#each xs}}{{name}}|{{this.name}}{{/each}}", { name: "root", xs: [{ name: null }, {}] })).toBe("|root|");
  });
  test("empty and non-array each uses else with existing context", () => {
    for (const xs of [[], null, undefined, {}, "abc", 0]) {
      expect(render("{{#each xs}}bad{{else}}{{title}}{{/each}}", { xs, title: "empty" })).toBe("empty");
    }
    expect(render("{{#each xs}}{{this}}{{/each}}", { xs: [0, false, null] })).toBe("0false");
  });
  test("reports structural errors with source locations", () => {
    for (const [template, message] of [
      ["{{#wat x}}", "Unknown block"], ["{{/if}}", "Unexpected closing"],
      ["{{#if x}}{{/each}}", "Mismatched closing"], ["{{#if x}}", "Unclosed if"],
      ["{{#each x}}", "Unclosed each"], ["{{else}}", "else outside"],
      ["{{#if x}}{{else}}{{else}}{{/if}}", "Duplicate else"],
      ["{{x", "Unclosed tag"], ["{{#if}}", "Invalid path"],
      ["{{#if no}}{{#unknown x}}{{/if}}", "Unknown block"],
    ]) {
      expect(() => render(template!, {})).toThrow(message!);
      expect(() => render(template!, {})).toThrow(/line \d+, column \d+/);
    }
    expect(() => render("abc\n  {{else}}", {})).toThrow("line 2, column 3");
  });
  test("rejects nonscalar output in escaped and raw tags", () => {
    for (const value of [{}, [], () => "x"]) {
      for (const tag of ["{{value}}", "{{{value}}}"]) {
        expect(() => render(tag, { value })).toThrow(/non-scalar.*value.*line 1, column 1/);
      }
    }
    expect(render("{{#if no}}{{value}}{{/if}}", { value: {} })).toBe("");
  });
});
