import { describe, expect, test } from "bun:test";
import { render } from "../src/engine.ts";

describe("interpolation", () => {
  test("escapes all five HTML characters and supports raw values", () => {
    expect(render("{{value}}|{{{ value }}}", { value: `&<>"'` }))
      .toBe(`&amp;&lt;&gt;&quot;&#39;|&<>"'`);
  });
  test("preserves whitespace, Unicode, and comments", () => {
    expect(render(" \tПривет\r\n{{! ignored\ntext }} {{ x }}\n", { x: "世界" }))
      .toBe(" \tПривет\r\n 世界\n");
    expect(render("", {})).toBe("");
  });
  test("resolves dotted paths and primitive values", () => {
    expect(render("{{a.0.b}}/{{zero}}/{{no}}/{{big}}", {
      a: [{ b: "ok" }], zero: 0, no: false, big: 12n,
    })).toBe("ok/0/false/12");
    expect(render("{{this}}", "root")).toBe("root");
  });
  test("missing and nullish values are empty", () => {
    expect(render("{{missing.deep}}/{{a}}/{{b}}/{{@index}}", { a: null, b: undefined })).toBe("///");
    expect(render("{{missing}}", null)).toBe("");
  });
  test("does not expose inherited properties", () => {
    expect(render("{{toString}}/{{constructor}}/{{__proto__}}", {})).toBe("//");
    expect(render("{{inherited}}", Object.create({ inherited: "secret" }))).toBe("");
  });
  for (const value of [{}, [], () => "text"]) {
    test(`rejects non-scalar ${typeof value} values in escaped and raw tags`, () => {
      for (const tag of ["{{value}}", "{{{value}}}"]) {
        expect(() => render(`\n  ${tag}`, { value })).toThrow(/Cannot render.*scalar text.*line 2, column 3/);
      }
    });
  }
});

describe("blocks", () => {
  test("uses the specified truthiness", () => {
    const template = "{{#if value}}yes{{else}}no{{/if}}";
    for (const value of ["", 0, false, null, undefined, [], NaN]) {
      expect(render(template, { value })).toBe("no");
    }
    for (const value of ["0", 1, true, {}, [false]]) {
      expect(render(template, { value })).toBe("yes");
    }
    expect(render(template, {})).toBe("no");
  });
  test("supports nested if branches and optional else", () => {
    const template = "{{#if a}}A{{#if b}}B{{else}}C{{/if}}{{else}}{{#if b}}D{{else}}E{{/if}}{{/if}}";
    expect(render(template, { a: true, b: false })).toBe("AC");
    expect(render(template, { a: false, b: true })).toBe("D");
    expect(render(template, {})).toBe("E");
    expect(render("{{#if missing}}x{{/if}}", {})).toBe("");
  });
  test("iterates primitives and resolves root paths", () => {
    expect(render("{{#each items}}{{@index}}={{this}}/{{title}};{{/each}}", {
      items: ["a", "b"], title: "root",
    })).toBe("0=a/root;1=b/root;");
  });
  test("prefers local own paths and handles nullish shadowing", () => {
    expect(render("{{#each items}}{{name}}/{{deep.x}};{{/each}}", {
      name: "root", deep: { x: "fallback" },
      items: [{ name: "local", deep: { x: "child" } }, { name: null }, { name: undefined }, {}],
    })).toBe("local/child;/fallback;/fallback;root/fallback;");
  });
  test("nested loops restore this and index and if retains loop context", () => {
    expect(render("{{#each groups}}{{@index}}:{{this.name}}[{{#each this.values}}{{#if this}}{{@index}}={{this}}/{{title}};{{/if}}{{/each}}]{{@index}}:{{name}}|{{/each}}", {
      title: "R", groups: [{ name: "A", values: ["x", "y"] }, { name: "B", values: ["z"] }],
    })).toBe("0:A[0=x/R;1=y/R;]0:A|1:B[0=z/R;]1:B|");
  });
  test("each else handles empty, missing, and non-array values", () => {
    for (const items of [[], undefined, null, {}, "abc", 1]) {
      expect(render("{{#each items}}body{{else}}empty{{/each}}", { items })).toBe("empty");
    }
    expect(render("{{#each missing}}body{{/each}}", {})).toBe("");
    expect(render("{{#each items}}{{#each children}}x{{else}}{{name}}:{{@index}}{{/each}}{{/each}}", {
      items: [{ name: "A", children: [] }],
    })).toBe("A:0");
  });
  test("skips non-scalar interpolation in unused branches", () => {
    expect(render("{{#if no}}{{obj}}{{else}}ok{{/if}}", { obj: {} })).toBe("ok");
  });
});

describe("syntax errors", () => {
  const cases: [string, RegExp][] = [
    ["{{#unknown x}}", /Unknown block/],
    ["{{#if x}}{{/each}}", /Mismatched closing tag/],
    ["{{/if}}", /Unexpected closing tag/],
    ["{{#each x}}", /Unclosed each block/],
    ["{{#if x}}{{else}}{{else}}{{/if}}", /Duplicate else/],
    ["{{else}}", /else outside a block/],
    ["{{value", /Unclosed tag/],
    ["{{{value}}", /Unclosed tag/],
    ["{{#if}}", /Invalid path/],
    ["{{}}", /Invalid path/],
    ["{{a..b}}", /Invalid path/],
  ];
  for (const [template, error] of cases) {
    test(template, () => {
      expect(() => render(template, {})).toThrow(error);
      expect(() => render(template, {})).toThrow(/line \d+, column \d+/);
    });
  }
  test("reports exact multiline locations and validates unused branches", () => {
    expect(() => render("first\n  {{else}}", {})).toThrow("line 2, column 3");
    expect(() => render("\n{{#if no}}\n    {{/each}}", {})).toThrow("line 3, column 5");
    expect(() => render("\n  {{#if no}}", {})).toThrow("line 2, column 3");
  });
});
