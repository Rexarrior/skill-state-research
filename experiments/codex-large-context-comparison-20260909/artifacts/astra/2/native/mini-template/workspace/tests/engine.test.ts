import { describe, expect, test } from "bun:test";
import { render } from "../src/engine.ts";

describe("interpolation", () => {
  test("preserves whitespace and removes comments", () => {
    expect(render(" \tA\r\n{{! ignored }} B\n", {})).toBe(" \tA\r\n B\n");
    expect(render("", null)).toBe("");
  });

  test("escapes all five HTML characters and supports raw text", () => {
    expect(render("{{ value }}|{{{ value }}}", { value: `&<>"'` }))
      .toBe(`&amp;&lt;&gt;&quot;&#39;|&<>"'`);
  });

  test("resolves dotted and numeric paths and scalar roots", () => {
    expect(render("{{users.0.name}}/{{count}}/{{ok}}/{{big}}", {
      users: [{ name: "Ada" }], count: 0, ok: false, big: 12n,
    })).toBe("Ada/0/false/12");
    expect(render("{{this}}", "root")).toBe("root");
  });

  test("missing and nullish values are empty", () => {
    expect(render("{{absent.deep}}|{{nil}}|{{undef}}|{{@index}}", {
      nil: null, undef: undefined,
    })).toBe("|||");
    expect(render("{{anything}}", undefined)).toBe("");
  });

  test("does not expose inherited properties", () => {
    const data = Object.assign(Object.create({ inherited: "hidden" }), { own: "yes" });
    expect(render("{{own}}/{{inherited}}/{{constructor}}/{{__proto__}}", data)).toBe("yes///");
  });

  for (const value of [{}, [], () => "bad", Symbol("bad")]) {
    test(`rejects non-scalar ${typeof value} values in escaped and raw tags`, () => {
      for (const tag of ["{{value}}", "{{{value}}}"]) {
        expect(() => render(`\n  ${tag}`, { value })).toThrow(/Cannot render "value" as scalar text.*line 2, column 3/);
      }
    });
  }
});

describe("conditionals", () => {
  for (const value of ["", 0, 0n, false, null, undefined, []]) {
    test(`false branch for ${String(value)}`, () => {
      expect(render("{{#if value}}yes{{else}}no{{/if}}", { value })).toBe("no");
      expect(render("{{#if value}}yes{{/if}}", { value })).toBe("");
    });
  }

  for (const value of ["0", 1, -1, true, {}, [false], NaN]) {
    test(`true branch for ${String(value)}`, () => {
      expect(render("{{#if value}}yes{{else}}no{{/if}}", { value })).toBe("yes");
    });
  }

  test("nested if and alternate branches", () => {
    const template = "{{#if a}}A{{#if b}}B{{else}}C{{/if}}{{else}}{{#if c}}D{{else}}E{{/if}}{{/if}}";
    expect(render(template, { a: true, b: false })).toBe("AC");
    expect(render(template, { a: false, c: true })).toBe("D");
    expect(render(template, {})).toBe("E");
  });

  test("does not evaluate unselected interpolations", () => {
    expect(render("{{#if no}}{{bad}}{{else}}ok{{/if}}", { bad: {} })).toBe("ok");
  });
});

describe("loops", () => {
  test("scalar items, indices, and root fallback", () => {
    expect(render("{{#each items}}{{@index}}={{this}}/{{title}};{{/each}}", {
      items: ["a", "b"], title: "root",
    })).toBe("0=a/root;1=b/root;");
  });

  test("local paths take precedence and explicit this never falls back", () => {
    expect(render("{{#each items}}[{{name}}|{{this.name}}|{{nested.value}}]{{/each}}", {
      name: "root", nested: { value: "fallback" },
      items: [{ name: "local", nested: {} }, {}, { name: null }, { name: undefined }],
    })).toBe("[local|local|fallback][root||fallback][||fallback][||fallback]");
  });

  test("nested loops restore items and indices", () => {
    expect(render("{{#each groups}}O{{@index}}:{{#each this.items}}I{{@index}}={{this}}/{{title}};{{/each}}O{{@index}}={{this.name}};{{/each}}", {
      title: "R", groups: [{ name: "A", items: ["x", "y"] }, { name: "B", items: ["z"] }],
    })).toBe("O0:I0=x/R;I1=y/R;O0=A;O1:I0=z/R;O1=B;");
  });

  test("if inside each preserves context and each inside if works", () => {
    expect(render("{{#if items}}{{#each items}}{{#if this.ok}}{{@index}}:{{this.name}}{{else}}skip{{/if}};{{/each}}{{/if}}", {
      items: [{ ok: true, name: "A" }, { ok: false, name: "B" }],
    })).toBe("0:A;skip;");
  });

  test("nested empty loop alternate retains enclosing context", () => {
    expect(render("{{#each items}}{{#each this.children}}child{{else}}{{@index}}:{{this.name}}{{/each}}{{/each}}", {
      items: [{ name: "A", children: [] }],
    })).toBe("0:A");
  });

  for (const value of [[], null, undefined, {}, "abc", 3, false]) {
    test(`empty/non-array each ${String(value)}`, () => {
      expect(render("{{#each items}}item{{else}}empty{{/each}}", { items: value })).toBe("empty");
      expect(render("{{#each items}}item{{/each}}", { items: value })).toBe("");
    });
  }
});

describe("syntax errors", () => {
  const cases: [string, RegExp][] = [
    ["{{#unless x}}", /Unknown block/],
    ["{{/if}}", /Unexpected closing tag/],
    ["{{#if x}}{{/each}}", /Mismatched closing tag/],
    ["{{#each x}}{{/if}}", /Mismatched closing tag/],
    ["{{#if x}}", /Unclosed if block/],
    ["{{#each x}}", /Unclosed each block/],
    ["{{#if x}}{{else}}{{else}}{{/if}}", /Duplicate else/],
    ["{{#each x}}{{else}}{{else}}{{/each}}", /Duplicate else/],
    ["{{else}}", /else outside a block/],
    ["{{#if}}", /Invalid path/],
    ["{{#each }}", /Invalid path/],
    ["{{a..b}}", /Invalid path/],
    ["{{}}", /Invalid path/],
    ["{{#if x}}{{else extra}}{{/if}}", /Invalid path/],
    ["{{value", /Unclosed tag/],
    ["{{{value}}", /Unclosed tag/],
  ];

  for (const [template, message] of cases) {
    test(template, () => {
      expect(() => render(template, {})).toThrow(message);
      expect(() => render(template, {})).toThrow(/line \d+, column \d+/);
    });
  }

  test("reports precise position after multiline text and tags", () => {
    expect(() => render("one\n{{! a\nb }}  {{/if}}", {}))
      .toThrow(/line 3, column 7/);
    expect(() => render("\r\n  {{#if x}}", {})).toThrow(/line 2, column 3/);
  });

  test("validates blocks even in unselected branches", () => {
    expect(() => render("{{#if no}}{{#unknown x}}{{/unknown}}{{/if}}", {})).toThrow(/Unknown block/);
  });
});
