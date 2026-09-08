import { describe, expect, test } from "bun:test";
import { render } from "../src/engine.ts";

describe("interpolation", () => {
  test("escapes all five HTML characters and supports raw text", () => {
    expect(render("{{value}}|{{{value}}}", { value: `&<>"'` })).toBe("&amp;&lt;&gt;&quot;&#39;|&<>\"'");
  });
  test("preserves whitespace, Unicode, and comments", () => {
    expect(render(" \r\n привет {{! ignored }}\t{{ user.name }}\n", { user: { name: "世界" } })).toBe(" \r\n привет \t世界\n");
  });
  test("handles missing values and scalar roots", () => {
    expect(render("{{absent.deep}}/{{nil}}/{{zero}}/{{no}}/{{big}}", { nil: null, zero: 0, no: false, big: 42n })).toBe("//0/false/42");
    expect(render("{{this}}", "root")).toBe("root");
    expect(render("{{missing}}", null)).toBe("");
  });
  test("only resolves own properties", () => {
    expect(render("{{inherited}}/{{own}}/{{constructor}}", Object.assign(Object.create({ inherited: "bad" }), { own: "ok" }))).toBe("/ok/");
    expect(render("{{items.0.name}}", { items: [{ name: "first" }] })).toBe("first");
  });
  for (const value of [{}, [], () => 1, Symbol("x")]) {
    test(`rejects non-scalar ${typeof value}`, () => {
      for (const tag of ["{{value}}", "{{{value}}}"]) expect(() => render(`a\n  ${tag}`, { value })).toThrow(/non-scalar.*line 2, column 3/);
    });
  }
});

describe("blocks", () => {
  for (const value of ["", 0, -0, 0n, false, null, undefined, []]) {
    test(`false branch for ${String(value)}`, () => {
      expect(render("{{#if value}}yes{{else}}no{{/if}}", { value })).toBe("no");
    });
  }
  for (const value of ["0", 1, true, {}, [0], NaN]) {
    test(`true branch for ${String(value)}`, () => {
      expect(render("{{#if value}}yes{{else}}no{{/if}}", { value })).toBe("yes");
    });
  }
  test("nested if and else, including blocks in alternate branches", () => {
    const template = "{{#if a}}A{{#if b}}B{{else}}C{{/if}}{{else}}{{#if b}}D{{else}}E{{/if}}{{/if}}";
    expect(render(template, { a: true, b: false })).toBe("AC");
    expect(render(template, { a: false, b: true })).toBe("D");
    expect(render(template, {})).toBe("E");
    expect(render("{{#if absent}}hidden{{/if}}", {})).toBe("");
  });
  test("nested loops restore context and fall back to root", () => {
    const template = "{{#each groups}}{{@index}}:{{name}}[{{#each items}}{{@index}}={{this}}/{{site}};{{else}}empty{{/each}}]{{name}}/{{@index}}|{{/each}}";
    expect(render(template, { site: "root", groups: [{ name: "A", items: ["x", "y"] }, { name: "B", items: [] }] })).toBe("0:A[0=x/root;1=y/root;]A/0|1:B[empty]B/1|");
  });
  test("item properties take precedence and undefined does not fall back", () => {
    expect(render("{{#each items}}{{name}}/{{this.name}}/{{site}};{{/each}}", { name: "root", site: "S", items: [{ name: "local" }, { name: undefined }, {}] })).toBe("local/local/S;//S;root//S;");
  });
  test("each alternate handles empty and non-array values", () => {
    for (const items of [[], null, undefined, {}, "abc", 1]) {
      expect(render("{{#each items}}yes{{else}}empty{{/each}}", { items })).toBe("empty");
    }
    expect(render("{{#each items}}yes{{/each}}", {})).toBe("");
  });
});

describe("structural diagnostics", () => {
  const cases: [string, RegExp][] = [
    ["{{#unknown x}}", /Unknown block/],
    ["{{/if}}", /Unexpected closing/],
    ["{{#if x}}{{/each}}", /Mismatched closing/],
    ["{{#if x}}", /Unclosed if/],
    ["{{#each x}}", /Unclosed each/],
    ["{{else}}", /else outside/],
    ["{{#if x}}{{else}}{{else}}{{/if}}", /Duplicate else/],
    ["{{#if}}", /Invalid path/],
    ["{{a..b}}", /Invalid path/],
    ["{{value", /Unclosed tag/],
  ];
  for (const [template, error] of cases) {
    test(template, () => {
      expect(() => render(template, {})).toThrow(error);
      expect(() => render(template, {})).toThrow(/line \d+, column \d+/);
    });
  }
  test("reports exact multiline location and validates inactive branches", () => {
    expect(() => render("first\n  {{else}}", {})).toThrow(/line 2, column 3/);
    expect(() => render("{{#if no}}{{#unknown x}}{{/if}}", {})).toThrow(/Unknown block/);
  });
});
