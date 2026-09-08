import { describe, expect, test } from "bun:test";
import { render } from "../src/engine.ts";

describe("interpolation", () => {
  test("escaping, raw text, comments, and exact whitespace", () => {
    expect(render("\t{{ value }}\n{{{value}}} {{! ignored }}\r\n", { value: `&<>"'` }))
      .toBe(`\t&amp;&lt;&gt;&quot;&#39;\n&<>"' \r\n`);
    expect(render("", {})).toBe("");
  });
  test("paths, missing values, and primitives", () => {
    expect(render("{{a.0.b}}/{{missing}}/{{nil}}/{{zero}}/{{flag}}", {
      a: [{ b: "yes" }], nil: null, zero: 0, flag: false,
    })).toBe("yes///0/false");
    expect(render("{{this}}", 42)).toBe("42");
    expect(render("{{x}}", undefined)).toBe("");
    expect(render("{{x}}", { x: 12n })).toBe("12");
  });
  test("does not expose inherited properties", () => {
    expect(render("{{toString}}{{constructor}}{{secret}}", Object.create({ secret: "hidden" }))).toBe("");
  });
  test("non-scalars produce located errors, including raw interpolation", () => {
    for (const x of [{}, [], () => 1]) {
      for (const tag of ["{{x}}", "{{{x}}}"]) {
        expect(() => render(`one\n  ${tag}`, { x })).toThrow(/non-scalar.*line 2, column 3/);
      }
    }
  });
});

describe("blocks", () => {
  test("truthiness", () => {
    for (const value of ["", 0, false, null, undefined, []]) {
      expect(render("{{#if value}}Y{{else}}N{{/if}}", { value })).toBe("N");
    }
    for (const value of ["0", 1, true, {}, [0]]) {
      expect(render("{{#if value}}Y{{else}}N{{/if}}", { value })).toBe("Y");
    }
    expect(render("{{#if missing}}Y{{/if}}", {})).toBe("");
  });
  test("nested conditionals and unused branches", () => {
    expect(render("{{#if a}}A{{#if b}}B{{else}}C{{/if}}{{else}}{{object}}{{/if}}", {
      a: true, b: false, object: {},
    })).toBe("AC");
  });
  test("nested loops restore context and use root fallback", () => {
    const template = "{{#each groups}}{{@index}}:{{name}}[{{#each items}}{{@index}}={{this}}/{{title}};{{/each}}]{{name}}/{{@index}}{{/each}}";
    expect(render(template, { title: "root", groups: [{ name: "A", items: ["x", "y"] }, { name: "B", items: ["z"] }] }))
      .toBe("0:A[0=x/root;1=y/root;]A/01:B[0=z/root;]B/1");
  });
  test("local values and explicit this", () => {
    expect(render("{{#each rows}}{{name}}:{{this.name}}:{{deep.x}};{{/each}}", {
      name: "root", deep: { x: "fallback" }, rows: [{ name: "local" }, {}, { name: null }, { name: undefined }],
    })).toBe("local:local:fallback;root::fallback;::fallback;::fallback;");
  });
  test("empty and non-array each branches preserve enclosing context", () => {
    for (const items of [[], null, false, {}, "abc", undefined]) {
      expect(render("{{#each items}}Y{{else}}N{{/each}}", { items })).toBe("N");
    }
    expect(render("{{#each rows}}{{#each empty}}bad{{else}}{{this.name}}/{{@index}}{{/each}}{{/each}}", {
      rows: [{ name: "A" }], empty: [],
    })).toBe("A/0");
  });
});

describe("syntax errors", () => {
  const cases: [string, RegExp][] = [
    ["{{#unknown x}}", /Unknown block/],
    ["{{#if x}}{{/each}}", /Mismatched closing/],
    ["{{/if}}", /Unexpected closing/],
    ["{{#if x}}", /Unclosed if block/],
    ["{{#each x}}", /Unclosed each block/],
    ["{{#if x}}{{else}}{{else}}{{/if}}", /Duplicate else/],
    ["{{else}}", /else outside/],
    ["{{x", /Unclosed tag/],
    ["{{{x}}", /Unclosed tag/],
    ["{{#if}}", /Invalid path/],
    ["{{a..b}}", /Invalid path/],
  ];
  for (const [template, message] of cases) {
    test(template, () => {
      expect(() => render(template, {})).toThrow(message);
      expect(() => render(template, {})).toThrow(/line 1, column \d+/);
    });
  }
  test("error coordinates and parsing inactive branches", () => {
    expect(() => render("hello\r\n  {{else}}", {})).toThrow(/line 2, column 3/);
    expect(() => render("{{#if absent}}{{#bad x}}{{/if}}", {})).toThrow(/Unknown block/);
  });
});
