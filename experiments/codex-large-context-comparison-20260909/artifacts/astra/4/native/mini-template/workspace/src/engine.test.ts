import { describe, expect, test } from "bun:test";
import { render } from "./engine";

describe("interpolation", () => {
  test("escapes all five HTML characters and supports raw output", () => {
    expect(render("{{value}}|{{{ value }}}", { value: `&<>"'` }))
      .toBe(`&amp;&lt;&gt;&quot;&#39;|&<>"'`);
  });

  test("preserves whitespace, comments, and adjacent tags", () => {
    expect(render(" \r\n\t{{! hidden }}{{a}}{{b}}\n ", { a: 0, b: false }))
      .toBe(" \r\n\t0false\n ");
    expect(render("", null)).toBe("");
    expect(render("plain { text }", null)).toBe("plain { text }");
  });

  test("resolves dotted paths, missing values, and primitive roots", () => {
    expect(render("{{a.b.0}}/{{a.missing}}/{{nil}}", { a: { b: [42] }, nil: null })).toBe("42//");
    expect(render("{{this}}/{{missing}}", "root")).toBe("root/");
    expect(render("{{x.y}}", undefined)).toBe("");
    expect(render("{{this}}", 123n)).toBe("123");
  });

  test("does not expose inherited properties", () => {
    expect(render("{{toString}}/{{constructor}}/{{secret}}", Object.create({ secret: "hidden" }))).toBe("//");
  });

  test("rejects non-scalars with source location in escaped and raw tags", () => {
    for (const value of [{}, [], () => "no"]) {
      for (const tag of ["{{value}}", "{{{value}}}"]) {
        expect(() => render(`first\n  ${tag}`, { value })).toThrow(/scalar text.*line 2, column 3/);
      }
    }
  });
});

describe("blocks", () => {
  test("implements conditional truthiness", () => {
    for (const value of ["", 0, -0, false, null, undefined, [], NaN]) {
      expect(render("{{#if value}}yes{{else}}no{{/if}}", { value })).toBe("no");
    }
    for (const value of ["0", 1, true, {}, [0]]) {
      expect(render("{{#if value}}yes{{else}}no{{/if}}", { value })).toBe("yes");
    }
    expect(render("a{{#if absent}}hidden{{/if}}b", {})).toBe("ab");
  });

  test("supports nested conditionals and inactive non-scalar branches", () => {
    const template = "{{#if a}}A{{#if b}}B{{else}}C{{/if}}{{else}}{{obj}}{{/if}}";
    expect(render(template, { a: true, b: false, obj: {} })).toBe("AC");
    expect(render(template, { a: true, b: true, obj: {} })).toBe("AB");
  });

  test("iterates primitives, with root fallback and indices", () => {
    expect(render("{{#each items}}{{@index}}={{this}}:{{title}};{{/each}}", {
      items: ["a", "b"], title: "root",
    })).toBe("0=a:root;1=b:root;");
  });

  test("falls back only for absent complete paths", () => {
    expect(render("{{#each items}}{{name}}/{{user.name}}/{{this.missing}};{{/each}}", {
      name: "root", user: { name: "Ada" }, missing: "root",
      items: [{ name: "local", user: {} }, { name: undefined }, { name: null }],
    })).toBe("local/Ada/;/Ada/;/Ada/;");
  });

  test("nested loops and if blocks preserve and restore context", () => {
    expect(render("{{#each groups}}{{@index}}:{{name}}[{{#each children}}{{#if this}}{{@index}}={{this}}/{{title}};{{/if}}{{else}}empty{{/each}}]{{@index}}:{{name}}|{{/each}}", {
      title: "R", groups: [{ name: "A", children: ["x", "y"] }, { name: "B", children: [] }],
    })).toBe("0:A[0=x/R;1=y/R;]0:A|1:B[empty]1:B|");
  });

  test("each selects else for empty and non-array values", () => {
    for (const value of [[], undefined, null, {}, "abc", 1]) {
      expect(render("{{#each value}}yes{{else}}no{{/each}}", { value })).toBe("no");
      expect(render("{{#each value}}yes{{/each}}", { value })).toBe("");
    }
  });
});

describe("syntax errors", () => {
  const cases: [string, RegExp][] = [
    ["{{#unknown x}}{{/unknown}}", /Unknown block/],
    ["{{#if x}}{{/each}}", /Mismatched closing/],
    ["{{/if}}", /Unexpected closing/],
    ["{{#if x}}", /Unclosed block/],
    ["{{#each x}}{{else}}{{else}}{{/each}}", /Duplicate else/],
    ["{{else}}", /outside a block/],
    ["{{value", /Unclosed tag/],
    ["{{{value}}", /Unclosed tag/],
    ["{{#if}}", /dotted path/],
    ["{{a..b}}", /dotted path/],
    ["{{}}", /dotted path/],
    ["{{#if missing}}{{#unknown x}}{{/unknown}}{{/if}}", /Unknown block/],
  ];
  for (const [template, message] of cases) {
    test(template, () => {
      expect(() => render(template, {})).toThrow(message);
      expect(() => render(template, {})).toThrow(/line \d+, column \d+/);
    });
  }
  test("reports exact line and column", () => {
    expect(() => render("one\r\n  {{else}}", {})).toThrow("line 2, column 3");
    expect(() => render("one\n  {{#if x}}\ntext", {})).toThrow("line 2, column 3");
  });
});
