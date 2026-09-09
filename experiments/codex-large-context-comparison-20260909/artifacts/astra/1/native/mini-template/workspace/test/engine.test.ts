import { describe, expect, test } from "bun:test";
import { render } from "../src/engine";

describe("interpolation", () => {
  test("escapes all five characters and supports raw text", () => {
    expect(render("{{value}}|{{{value}}}", { value: `&<>"'` }))
      .toBe(`&amp;&lt;&gt;&quot;&#39;|&<>"'`);
  });
  test("preserves whitespace and removes comments", () => {
    expect(render(" \r\n\t{{! ignored }}A\n {{ value }}  ", { value: "B" })).toBe(" \r\n\tA\n B  ");
    expect(render("", null)).toBe("");
  });
  test("resolves dot paths, array indices, root this, and missing values", () => {
    expect(render("{{items.0.name}}/{{this.items.0.name}}/{{missing}}/{{nil}}/{{@index}}", {
      items: [{ name: "Ada" }], nil: null,
    })).toBe("Ada/Ada///");
    expect(render("{{this}}", "root")).toBe("root");
    expect(render("{{missing.x}}", undefined)).toBe("");
  });
  test("renders scalar values", () => {
    expect(render("{{a}}|{{b}}|{{c}}", { a: 0, b: false, c: 42n })).toBe("0|false|42");
  });
  test("does not expose inherited properties", () => {
    expect(render("{{secret}}/{{constructor}}/{{__proto__}}", Object.create({ secret: "hidden" }))).toBe("//");
  });
  for (const value of [{}, [], () => 1, Symbol("x")]) {
    test(`rejects non-scalar ${typeof value}`, () => {
      for (const tag of ["{{value}}", "{{{value}}}"]) {
        expect(() => render(`\n${tag}`, { value })).toThrow(/non-scalar.*value.*line 2, column 1/);
      }
    });
  }
});

describe("blocks", () => {
  test("uses specified truthiness", () => {
    for (const value of ["", 0, false, null, undefined, [], NaN]) {
      expect(render("{{#if value}}T{{else}}F{{/if}}", { value })).toBe("F");
    }
    for (const value of ["0", 1, true, {}, [false]]) {
      expect(render("{{#if value}}T{{else}}F{{/if}}", { value })).toBe("T");
    }
  });
  test("nests conditionals and allows omitted else", () => {
    const source = "{{#if a}}A{{#if b}}B{{else}}C{{/if}}{{else}}D{{/if}}";
    expect(render(source, { a: true, b: false })).toBe("AC");
    expect(render(source, { a: false, b: true })).toBe("D");
    expect(render("{{#if missing}}x{{/if}}", {})).toBe("");
  });
  test("iterates primitives, with root fallback and index", () => {
    expect(render("{{#each items}}{{@index}}={{this}}:{{title}};{{/each}}", {
      items: ["a", 0, false, null], title: "R",
    })).toBe("0=a:R;1=0:R;2=false:R;3=:R;");
  });
  test("local values win; undefined falls back; explicit this stays local", () => {
    expect(render("{{#each items}}[{{name}}|{{this.name}}]{{/each}}", {
      name: "root", items: [{ name: "local" }, {}, { name: null }, { name: false }],
    })).toBe("[local|local][root|][|][false|false]");
  });
  test("nested loops restore item and index, and if retains loop context", () => {
    expect(render("{{#each groups}}{{@index}}:{{this.name}}({{#each this.items}}{{@index}}={{this}}/{{title}};{{/each}}){{#if this.name}}{{this.name}}@{{@index}}{{/if}}|{{/each}}", {
      title: "R", groups: [{ name: "A", items: ["x", "y"] }, { name: "B", items: ["z"] }],
    })).toBe("0:A(0=x/R;1=y/R;)A@0|1:B(0=z/R;)B@1|");
  });
  test("empty and non-array loops use else with the surrounding context", () => {
    for (const value of [[], {}, "abc", 0, null, undefined]) {
      expect(render("{{#each value}}X{{else}}empty{{/each}}", { value })).toBe("empty");
      expect(render("{{#each value}}X{{/each}}", { value })).toBe("");
    }
    expect(render("{{#each items}}{{#each this.empty}}X{{else}}{{this.name}}:{{@index}}{{/each}}{{/each}}", {
      items: [{ name: "A", empty: [] }],
    })).toBe("A:0");
  });
});

describe("syntax errors", () => {
  const cases: [string, RegExp][] = [
    ["{{#unknown x}}", /Unknown block/],
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
    ["{{a..b}}", /Invalid path/],
  ];
  for (const [source, message] of cases) {
    test(source, () => {
      expect(() => render(source, {})).toThrow(message);
      expect(() => render(source, {})).toThrow(/line \d+, column \d+/);
    });
  }
  test("reports exact line and column, including CRLF", () => {
    expect(() => render("a\r\n  {{else}}", {})).toThrow("line 2, column 3");
    expect(() => render("\n {{#if x}}", {})).toThrow("line 2, column 2");
  });
  test("validates unused branches", () => {
    expect(() => render("{{#if absent}}{{#bad x}}{{/bad}}{{/if}}", {})).toThrow(/Unknown block/);
  });
});
