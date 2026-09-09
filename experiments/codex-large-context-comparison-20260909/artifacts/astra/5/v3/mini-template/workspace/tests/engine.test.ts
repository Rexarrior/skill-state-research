import { describe, expect, test } from "bun:test";
import { render } from "../src/engine";

describe("render", () => {
  test("escapes all HTML characters and supports raw text", () => {
    expect(render("{{value}}|{{{value}}}", { value: `&<>"'` })).toBe(`&amp;&lt;&gt;&quot;&#39;|&<>"'`);
  });
  test("preserves whitespace, comments, dotted paths and scalar values", () => {
    expect(render(" \n{{! hidden }}\t{{ user.name }}:{{n}}/{{b}}/{{big}}\n", { user: { name: "Zoë" }, n: 0, b: false, big: 12n })).toBe(" \n\tZoë:0/false/12\n");
    expect(render("{{absent}}/{{a.b}}/{{n}}", { a: null, n: null })).toBe("//");
  });
  test("if truthiness and nested branches", () => {
    for (const value of ["", 0, false, null, undefined, [], NaN]) expect(render("{{#if value}}yes{{else}}no{{/if}}", { value })).toBe("no");
    for (const value of ["0", 1, true, {}, [0]]) expect(render("{{#if value}}yes{{else}}no{{/if}}", { value })).toBe("yes");
    expect(render("{{#if a}}A{{#if b}}B{{else}}C{{/if}}{{else}}D{{/if}}", { a: true, b: false })).toBe("AC");
  });
  test("nested loops, local paths, root fallback and context restoration", () => {
    const template = "{{#each groups}}{{@index}}/{{name}}/{{title}}:{{#each members}}{{@index}}={{this}};{{else}}empty{{/each}}[{{name}}:{{@index}}]{{/each}}";
    expect(render(template, { title: "Root", groups: [{ name: "A", members: ["x", "y"] }, { name: "B", members: [] }] })).toBe("0/A/Root:0=x;1=y;[A:0]1/B/Root:empty[B:1]");
    expect(render("{{#each items}}{{name}}/{{user.name}}{{/each}}", { name: "root", user: { name: "fallback" }, items: [{ name: null, user: {} }] })).toBe("/fallback");
  });
  test("each else handles absent, non-array and empty arrays", () => {
    for (const items of [undefined, null, [], {}, "abc", 4]) expect(render("{{#each items}}X{{else}}E{{/each}}", { items })).toBe("E");
    expect(render("{{#each this}}{{this}}:{{@index}} {{/each}}", [false, 0, null])).toBe("false:0 0:1 :2 ");
    expect(render("{{this}}/{{@index}}", "root")).toBe("root/");
  });
  test("only own properties resolve", () => {
    expect(render("{{secret}}/{{constructor}}/{{__proto__}}", Object.create({ secret: "hidden" }))).toBe("//");
  });
  test("rejects non-scalars in escaped and raw interpolations", () => {
    for (const value of [{}, [], () => "x", Symbol("x")]) {
      for (const tag of ["{{value}}", "{{{value}}}"]) expect(() => render(`\n ${tag}`, { value })).toThrow(/Cannot render 'value' as scalar text .*line 2, column 2/);
    }
  });
  test("structural errors have useful source locations", () => {
    for (const template of ["{{#unknown x}}", "{{/if}}", "{{#if x}}{{/each}}", "{{#if x}}", "{{else}}", "{{#each x}}{{else}}{{else}}{{/each}}", "{{value", "{{}}", "{{#if}}"])
      expect(() => render(`\n  ${template}`, {})).toThrow(/line 2, column \d+/);
    expect(() => render("{{#if no}}{{#bad x}}{{/if}}", {})).toThrow(/Unknown or malformed block/);
    expect(() => render("abc\n  {{/if}}", {})).toThrow("line 2, column 3");
  });
});
