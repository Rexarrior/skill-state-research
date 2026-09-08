import { describe, expect, test } from "bun:test";
import { render } from "../src/engine.ts";

describe("render", () => {
  test("escaping, raw values, scalars, missing values and exact whitespace", () => {
    expect(render(" \n{{ v }}|{{{v}}}|{{zero}}|{{no}}|{{nil}}|{{absent}}\t", {
      v: `&<>"'`, zero: 0, no: false, nil: null,
    })).toBe(" \n&amp;&lt;&gt;&quot;&#39;|&<>\"'|0|false||\t");
    expect(render("{{this}}", 42n)).toBe("42");
    expect(render("a{{! hidden }}b", {})).toBe("ab");
    expect(render("{{a.b.0.c}}", { a: { b: [{ c: "ok" }] } })).toBe("ok");
  });
  test("conditional truthiness and nested alternatives", () => {
    for (const value of ["", 0, 0n, false, null, undefined, []]) {
      expect(render("{{#if value}}yes{{else}}no{{/if}}", { value })).toBe("no");
    }
    for (const value of ["0", 1, true, {}, [0], NaN]) {
      expect(render("{{#if value}}yes{{else}}no{{/if}}", { value })).toBe("yes");
    }
    expect(render("{{#if a}}A{{#if b}}B{{else}}C{{/if}}{{else}}D{{/if}}", { a: true })).toBe("AC");
  });
  test("loops resolve local and root values and restore nested contexts", () => {
    const template = "{{#each groups}}{{@index}}={{name}}/{{title}}:{{#each items}}[{{@index}}:{{this}}/{{title}}]{{else}}empty{{/each}};{{@index}}{{/each}}";
    expect(render(template, { title: "Root", groups: [{ name: "A", items: ["x", "y"] }, { name: "B", items: [] }] }))
      .toBe("0=A/Root:[0:x/Root][1:y/Root];01=B/Root:empty;1");
    expect(render("{{#each xs}}{{name}}/{{this.name}};{{/each}}", { name: "root", xs: [{}, { name: null }, { name: "local" }] }))
      .toBe("root/;/;local/local;");
    for (const xs of [[], null, undefined, {}, "text", 0]) {
      expect(render("{{#each xs}}bad{{else}}{{title}}{{/each}}", { xs, title: "empty" })).toBe("empty");
    }
  });
  test("own properties only and explicit undefined shadows root", () => {
    expect(render("{{constructor}}/{{toString}}/{{__proto__}}", {})).toBe("//");
    expect(render("{{#each xs}}{{name}}{{/each}}", { name: "root", xs: [{ name: undefined }] })).toBe("");
  });
  test("rejects non-scalar interpolations in escaped and raw tags", () => {
    for (const value of [{}, [], () => 1, Symbol("x")]) {
      for (const tag of ["{{value}}", "{{{value}}}"]) {
        expect(() => render(`\n  ${tag}`, { value })).toThrow(/non-scalar.*line 2, column 3/);
      }
    }
  });
  test("syntax errors have useful locations, including inactive branches", () => {
    const cases: [string, RegExp][] = [
      ["{{#wat x}}", /Unknown block/],
      ["{{#if x}}{{/each}}", /Mismatched closing/],
      ["{{/if}}", /Unexpected closing/],
      ["{{#each xs}}", /Unclosed each/],
      ["{{#if x}}{{else}}{{else}}{{/if}}", /Duplicate else/],
      ["{{else}}", /else outside/],
      ["{{oops", /Unclosed tag/],
      ["{{#if}}", /Invalid path/],
      ["{{a..b}}", /Invalid path/],
      ["{{#if x}}{{#unknown y}}{{/unknown}}{{/if}}", /Unknown block/],
    ];
    for (const [template, message] of cases) {
      expect(() => render(`\n  ${template}`, {})).toThrow(message);
      expect(() => render(`\n  ${template}`, {})).toThrow(/line 2, column \d+/);
    }
    expect(() => render("one\ntwo\n  {{else}}", {})).toThrow("line 3, column 3");
  });
});
