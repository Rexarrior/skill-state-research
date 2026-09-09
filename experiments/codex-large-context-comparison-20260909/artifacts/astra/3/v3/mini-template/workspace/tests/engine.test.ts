import { expect, test } from "bun:test";
import { render } from "../src/engine";

test("escaping, raw values, scalars, comments and exact whitespace", () => {
  expect(render(" \n{{value}}|{{{value}}}\t{{! ignored }}\n", { value: `&<>"'` }))
    .toBe(" \n&amp;&lt;&gt;&quot;&#39;|&<>\"'\t\n");
  expect(render("{{a}}/{{b}}/{{c}}/{{d}}/{{e}}", { a: 0, b: false, c: null, d: 12n })).toBe("0/false//12/");
  expect(render("", {})).toBe("");
});

test("conditions implement truthiness and nest", () => {
  for (const value of ["", 0, false, null, undefined, [], NaN]) {
    expect(render("{{#if value}}yes{{else}}no{{/if}}", { value })).toBe("no");
  }
  for (const value of ["0", 1, true, {}, [0]]) {
    expect(render("{{#if value}}yes{{else}}no{{/if}}", { value })).toBe("yes");
  }
  expect(render("{{#if a}}A{{#if b}}B{{else}}C{{/if}}{{else}}D{{/if}}", { a: true, b: false })).toBe("AC");
});

test("nested loops restore context and resolve root fallbacks", () => {
  const template = "{{#each groups}}{{@index}}={{name}}:{{#each items}}{{@index}}/{{this}}/{{title}};{{else}}empty{{/each}}[{{@index}}/{{this.name}}]{{/each}}";
  expect(render(template, { title: "Root", groups: [{ name: "A", items: ["x", "y"] }, { name: "B", items: [] }] }))
    .toBe("0=A:0/x/Root;1/y/Root;[0/A]1=B:empty[1/B]");
  expect(render("{{#each xs}}{{name}}:{{this.name}};{{/each}}", { name: "root", xs: [{ name: null }, {}] })).toBe(":;root:;");
  for (const xs of [[], null, undefined, {}, "abc", false]) {
    expect(render("{{#each xs}}x{{else}}empty{{/each}}", { xs })).toBe("empty");
  }
});

test("paths and own-property lookup", () => {
  expect(render("{{a.0.b}} {{this.a.0.b}} {{@index}}", { a: [{ b: "ok" }] })).toBe("ok ok ");
  expect(render("{{toString}} {{constructor}}", {})).toBe(" ");
  expect(render("{{secret}}", Object.create({ secret: "hidden" }))).toBe("");
});

test("non-scalar interpolation is rejected, even in raw tags", () => {
  for (const value of [{}, [], () => 1]) {
    for (const template of ["{{value}}", "{{{value}}}"]) {
      expect(() => render(template, { value })).toThrow(/non-scalar.*value.*line 1, column 1/);
    }
  }
  expect(render("{{#if no}}{{object}}{{/if}}", { object: {} })).toBe("");
});

test("structural errors have useful locations, including inactive branches", () => {
  const cases = [
    ["{{#wat x}}", /Unknown block/],
    ["{{/if}}", /Unexpected closing/],
    ["{{#if x}}{{/each}}", /Mismatched closing/],
    ["{{#if x}}", /Unclosed if/],
    ["{{#each x}}", /Unclosed each/],
    ["{{#if x}}{{else}}{{else}}{{/if}}", /Duplicate else/],
    ["{{else}}", /else outside/],
    ["{{x", /Unclosed tag/],
    ["{{{x}}", /Unclosed tag/],
    ["{{#if}}", /Invalid path/],
    ["{{}}", /Invalid path/],
    ["{{#if no}}{{#unknown x}}{{/if}}", /Unknown block/],
  ] as const;
  for (const [template, error] of cases) {
    expect(() => render(template, {})).toThrow(error);
    expect(() => render(template, {})).toThrow(/line \d+, column \d+/);
  }
  expect(() => render("hello\n  {{else}}", {})).toThrow("line 2, column 3");
  expect(() => render("a\n {{#if x}}", {})).toThrow("line 2, column 2");
});
