import { describe, expect, test } from "bun:test";
import { render } from "../src/engine";

describe("interpolation", () => {
  test("escapes all five HTML characters and supports raw text", () => {
    expect(render("{{value}}|{{{value}}}", { value: `&<>"'` }))
      .toBe(`&amp;&lt;&gt;&quot;&#39;|&<>"'`);
  });
  test("preserves whitespace, ignores comments, and resolves dotted paths", () => {
    expect(render(" \r\n{{! ignored }}\t{{ user.names.0 }}\n ", { user: { names: ["Ada"] } }))
      .toBe(" \r\n\tAda\n ");
    expect(render("", null)).toBe("");
  });
  test("handles missing, null and scalar values", () => {
    expect(render("{{missing}}/{{a.b}}/{{nil}}/{{zero}}/{{no}}/{{big}}", {
      a: null, nil: null, zero: 0, no: false, big: 123n,
    })).toBe("///0/false/123");
    expect(render("{{this}}/{{@index}}", "root")).toBe("root/");
  });
  test("does not expose inherited properties", () => {
    expect(render("{{secret}}/{{toString}}/{{__proto__}}", Object.create({ secret: "hidden" }))).toBe("//");
  });
  test("rejects non-scalars with a location in escaped and raw tags", () => {
    for (const value of [{}, [], () => 1, Symbol("x")]) {
      for (const tag of ["{{value}}", "{{{value}}}"]) {
        expect(() => render(`hello\n  ${tag}`, { value })).toThrow(/non-scalar.*line 2, column 3/);
      }
    }
  });
});

describe("blocks", () => {
  test("implements conditional truthiness", () => {
    for (const value of ["", 0, false, null, undefined, [], NaN]) {
      expect(render("{{#if value}}yes{{else}}no{{/if}}", { value })).toBe("no");
    }
    for (const value of ["0", 1, true, {}, [0]]) {
      expect(render("{{#if value}}yes{{else}}no{{/if}}", { value })).toBe("yes");
    }
    expect(render("a{{#if missing}}b{{/if}}c", {})).toBe("ac");
  });
  test("nests conditionals and renders only selected branches", () => {
    expect(render("{{#if a}}A{{#if b}}B{{else}}C{{/if}}{{else}}{{obj}}{{/if}}", {
      a: true, b: false, obj: {},
    })).toBe("AC");
  });
  test("iterates primitive items and falls back to root paths", () => {
    expect(render("{{#each items}}[{{@index}}:{{this}}:{{title}}]{{/each}}", {
      items: ["x", "y"], title: "Root",
    })).toBe("[0:x:Root][1:y:Root]");
  });
  test("resolves item paths first and keeps explicit this local", () => {
    expect(render("{{#each items}}({{name}}|{{this.name}}|{{nil}}){{/each}}", {
      name: "root", nil: "fallback", items: [{ name: "local", nil: null }, {}],
    })).toBe("(local|local|)(root||fallback)");
  });
  test("restores nested loop item and index and preserves context through if", () => {
    expect(render("{{#each groups}}{{@index}}:{{name}}[{{#each children}}{{#if this}}{{@index}}={{this}}/{{title}};{{/if}}{{/each}}]{{name}}:{{@index}};{{/each}}", {
      title: "R", groups: [{ name: "A", children: ["a", "b"] }, { name: "B", children: ["c"] }],
    })).toBe("0:A[0=a/R;1=b/R;]A:0;1:B[0=c/R;]B:1;");
  });
  test("each else handles non-arrays and retains surrounding context", () => {
    for (const value of [[], {}, "abc", 2, null, undefined]) {
      expect(render("{{#each value}}bad{{else}}empty{{/each}}", { value })).toBe("empty");
    }
    expect(render("{{#each items}}{{#each children}}bad{{else}}{{name}}:{{@index}}{{/each}}{{/each}}", {
      items: [{ name: "outer", children: [] }],
    })).toBe("outer:0");
  });
});

describe("syntax errors", () => {
  const cases: [string, RegExp][] = [
    ["{{#unknown x}}{{/unknown}}", /Unknown block/],
    ["{{#if x}}{{/each}}", /Mismatched closing/],
    ["{{/if}}", /Unexpected closing/],
    ["{{#each x}}", /Unclosed each/],
    ["{{#if x}}{{else}}{{else}}{{/if}}", /Duplicate else/],
    ["{{else}}", /else outside/],
    ["{{x", /Unclosed tag/],
    ["{{{x}}", /Unclosed tag/],
    ["{{#if}}", /Invalid path/],
    ["{{a..b}}", /Invalid path/],
    ["{{}}", /Invalid path/],
  ];
  for (const [template, error] of cases) {
    test(template, () => {
      expect(() => render(`\n  ${template}`, {})).toThrow(error);
      expect(() => render(`\n  ${template}`, {})).toThrow(/line 2, column \d+/);
    });
  }
  test("checks syntax inside inactive branches", () => {
    expect(() => render("{{#if absent}}{{#unknown x}}{{/unknown}}{{/if}}", {})).toThrow(/Unknown block/);
  });
  test("reports the precise position of a mismatched closing tag", () => {
    expect(() => render("{{#if x}}\n  {{/each}}", {})).toThrow(/line 2, column 3/);
  });
});
