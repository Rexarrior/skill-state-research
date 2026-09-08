import { describe, expect, test } from "bun:test";
import { render } from "../src/engine";

describe("interpolation", () => {
  test("escapes all HTML characters and supports raw text", () => {
    expect(render("{{ value }}|{{{value}}}", { value: `&<>"'` }))
      .toBe(`&amp;&lt;&gt;&quot;&#39;|&<>"'`);
  });
  test("preserves whitespace and removes comments", () => {
    expect(render(" \n\tA{{! ignored }}\r\n B ", {})).toBe(" \n\tA\r\n B ");
  });
  test("renders scalar and missing values", () => {
    expect(render("{{a.b}}/{{zero}}/{{false}}/{{nil}}/{{absent}}", {
      a: { b: "ok" }, zero: 0, false: false, nil: null,
    })).toBe("ok/0/false//");
    expect(render("{{this}}", 42)).toBe("42");
    expect(render("{{x.y}}", null)).toBe("");
  });
  test("does not traverse inherited properties", () => {
    expect(render("{{toString}}/{{constructor}}/{{secret}}", Object.create({ secret: 1 }))).toBe("//");
  });
  for (const value of [{}, [], () => "x"]) {
    test(`rejects non-scalar ${typeof value}`, () => {
      expect(() => render("line\n  {{value}}", { value })).toThrow(/scalar text.*line 2, column 3/);
      expect(() => render("{{{value}}}", { value })).toThrow("scalar text");
    });
  }
});

describe("blocks", () => {
  for (const value of ["", 0, -0, false, null, undefined, []]) {
    test(`false branch for ${String(value)}`, () => {
      expect(render("{{#if value}}Y{{else}}N{{/if}}", { value })).toBe("N");
    });
  }
  for (const value of ["0", 1, true, {}, [0], NaN, 0n]) {
    test(`true branch for ${String(value)}`, () => {
      expect(render("{{#if value}}Y{{else}}N{{/if}}", { value })).toBe("Y");
    });
  }
  test("nested conditionals", () => {
    expect(render("{{#if a}}A{{#if b}}B{{else}}C{{/if}}{{else}}D{{/if}}", { a: true, b: false })).toBe("AC");
  });
  test("loop items, indexes, root fallback and nested loop restoration", () => {
    const template = "{{#each groups}}{{@index}}:{{name}}/{{title}}[{{#each children}}{{@index}}={{this}}/{{title}};{{/each}}]{{name}}:{{@index}};{{/each}}";
    expect(render(template, { title: "root", groups: [
      { name: "A", children: ["x", "y"] }, { name: "B", children: ["z"] },
    ] })).toBe("0:A/root[0=x/root;1=y/root;]A:0;1:B/root[0=z/root;]B:1;");
  });
  test("local null and undefined shadow root; absent paths fall back", () => {
    expect(render("{{#each items}}{{name}}/{{deep.x}};{{/each}}", {
      name: "root", deep: { x: "fallback" }, items: [{ name: null }, { name: undefined }, {}],
    })).toBe("/fallback;/fallback;root/fallback;");
  });
  test("each else handles empty, missing and non-array values", () => {
    for (const items of [[], undefined, null, {}, "abc", 1]) {
      expect(render("{{#each items}}Y{{else}}N{{/each}}", { items })).toBe("N");
    }
    expect(render("{{#each items}}Y{{/each}}", {})).toBe("");
  });
  test("loop else keeps enclosing context", () => {
    expect(render("{{#each rows}}{{#each children}}x{{else}}{{name}}:{{@index}}{{/each}}{{/each}}", {
      rows: [{ name: "A", children: [] }],
    })).toBe("A:0");
  });
});

describe("syntax errors", () => {
  const cases: [string, RegExp][] = [
    ["{{#unknown x}}", /Unknown or invalid block/],
    ["{{#if}}", /invalid block/],
    ["{{#if x}}{{/each}}", /Mismatched/],
    ["{{/if}}", /Unexpected closing/],
    ["{{#each x}}", /Unclosed 'each'/],
    ["{{#if x}}{{else}}{{else}}{{/if}}", /Duplicate else/],
    ["{{else}}", /else outside/],
    ["{{value", /Unclosed tag/],
    ["{{{value}}", /Unclosed tag/],
    ["{{}}", /Empty interpolation/],
  ];
  for (const [template, message] of cases) {
    test(template, () => {
      expect(() => render(template, {})).toThrow(message);
      expect(() => render(template, {})).toThrow(/line \d+, column \d+/);
    });
  }
  test("reports exact position", () => {
    expect(() => render("first\n  {{else}}", {})).toThrow("line 2, column 3");
  });
  test("validates inactive branches", () => {
    expect(() => render("{{#if missing}}{{#bad x}}{{/if}}", {})).toThrow("Unknown");
  });
});
