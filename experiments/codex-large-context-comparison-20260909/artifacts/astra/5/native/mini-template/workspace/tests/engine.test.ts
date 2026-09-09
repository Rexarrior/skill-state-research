import { describe, expect, test } from "bun:test";
import { render } from "../src/engine.ts";

describe("interpolation", () => {
  test("preserves whitespace and escapes all five HTML characters", () => {
    expect(render(" \n\t{{ value }}\r\n{{{value}}} ", { value: `&<>"'` }))
      .toBe(" \n\t&amp;&lt;&gt;&quot;&#39;\r\n&<>\"' ");
  });
  test("resolves paths and scalar values without dropping zero or false", () => {
    expect(render("{{user.name}}/{{xs.0}}/{{zero}}/{{bool}}/{{nil}}/{{missing.x}}", {
      user: { name: "Ada" }, xs: [12], zero: 0, bool: false, nil: null,
    })).toBe("Ada/12/0/false//");
    expect(render("{{this}}", 42)).toBe("42");
    expect(render("{{this}}", null)).toBe("");
  });
  test("comments can span lines", () => {
    expect(render("A{{! ignored\n text }} B", {})).toBe("A B");
  });
  test("only own properties are accessible", () => {
    expect(render("{{inherited}}/{{toString}}", Object.create({ inherited: "secret" }))).toBe("/");
  });
  for (const value of [{}, [], () => "text"]) {
    test(`rejects non-scalar ${typeof value} in both interpolation forms`, () => {
      for (const tag of ["{{value}}", "{{{value}}}"]) {
        expect(() => render(`\n  ${tag}`, { value })).toThrow(/scalar text.*line 2, column 3/);
      }
    });
  }
});

describe("blocks", () => {
  for (const value of ["", 0, 0n, false, null, undefined, []]) {
    test(`false branch for ${String(value)}`, () => {
      expect(render("{{#if value}}yes{{else}}no{{/if}}", { value })).toBe("no");
    });
  }
  for (const value of ["0", 1, true, {}, [false], NaN]) {
    test(`true branch for ${String(value)}`, () => {
      expect(render("{{#if value}}yes{{else}}no{{/if}}", { value })).toBe("yes");
    });
  }
  test("nested conditionals and optional else", () => {
    expect(render("{{#if a}}A{{#if b}}B{{else}}C{{/if}}{{else}}D{{/if}}", { a: true })).toBe("AC");
    expect(render("{{#if missing}}x{{/if}}", {})).toBe("");
  });
  test("loop items, root fallback, indices, and nested context restoration", () => {
    const template = "{{#each groups}}{{@index}}:{{name}}/{{title}}[{{#each members}}{{@index}}={{this}}/{{title}};{{/each}}]{{name}}:{{@index}}|{{/each}}";
    expect(render(template, { title: "Root", groups: [
      { name: "A", members: ["x", "y"] }, { name: "B", title: "Local", members: ["z"] },
    ] })).toBe("0:A/Root[0=x/Root;1=y/Root;]A:0|1:B/Local[0=z/Root;]B:1|");
  });
  test("missing full paths fall back, explicit null/undefined values do not", () => {
    expect(render("{{#each items}}{{user.name}}/{{name}}/{{nil}}/{{this.absent}}{{/each}}", {
      user: { name: "Root" }, name: "Root", nil: "Root", absent: "Root",
      items: [{ user: {}, name: undefined, nil: null }],
    })).toBe("Root///");
  });
  test("empty and non-array each values use else", () => {
    for (const items of [[], null, undefined, {}, "abc", 1]) {
      expect(render("{{#each items}}x{{else}}empty{{/each}}", { items })).toBe("empty");
    }
    expect(render("{{#each items}}x{{/each}}", {})).toBe("");
  });
  test("nested each else retains surrounding loop context", () => {
    expect(render("{{#each items}}{{#each this.children}}x{{else}}{{this.name}}:{{@index}}{{/each}}{{/each}}", {
      items: [{ name: "A", children: [] }],
    })).toBe("A:0");
  });
});

describe("syntax diagnostics", () => {
  const cases: [string, RegExp][] = [
    ["{{#unless x}}{{/unless}}", /Unknown block/],
    ["{{#if x}}{{/each}}", /Mismatched closing/],
    ["{{/if}}", /Unexpected closing/],
    ["{{#if x}}", /Unclosed if block/],
    ["{{#each x}}", /Unclosed each block/],
    ["{{#if x}}{{else}}{{else}}{{/if}}", /Duplicate else/],
    ["{{else}}", /else outside/],
    ["{{value", /Unclosed tag/],
    ["{{{value}}", /Unclosed tag/],
    ["{{#if}}", /Invalid path/],
    ["{{}}", /Invalid path/],
  ];
  for (const [template, message] of cases) {
    test(template, () => {
      expect(() => render(template, {})).toThrow(message);
      expect(() => render(template, {})).toThrow(/line \d+, column \d+/);
    });
  }
  test("reports precise tag locations and parses unselected branches", () => {
    expect(() => render("first\n  {{else}}", {})).toThrow("line 2, column 3");
    expect(() => render("{{#if no}}\n {{#unknown x}}{{/if}}", {})).toThrow("line 2, column 2");
  });
});
