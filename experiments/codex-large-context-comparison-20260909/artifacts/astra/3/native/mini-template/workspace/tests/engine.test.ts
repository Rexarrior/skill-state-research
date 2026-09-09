import { describe, expect, test } from "bun:test";
import { render } from "../src/engine.ts";

describe("interpolation", () => {
  test("escapes every HTML-sensitive character, with raw opt-out", () => {
    expect(render("{{ value }}|{{{ value }}}", { value: `&<>"'` }))
      .toBe("&amp;&lt;&gt;&quot;&#39;|&<>\"'");
  });

  test("preserves whitespace and removes comments", () => {
    expect(render(" \r\n\t{{! ignored }}Hello {{name}}\n  ", { name: "世界" }))
      .toBe(" \r\n\tHello 世界\n  ");
    expect(render("", {})).toBe("");
  });

  test("resolves paths and missing values without hiding false or zero", () => {
    expect(render("{{a.b.0}}|{{missing.x}}|{{nil}}|{{zero}}|{{no}}", {
      a: { b: ["ok"] }, nil: null, zero: 0, no: false,
    })).toBe("ok|||0|false");
    expect(render("{{this}}", 42)).toBe("42");
    expect(render("{{anything}}", null)).toBe("");
    expect(render("{{this}}", 123n)).toBe("123");
    expect(render("{{this}}", Symbol("x"))).toBe("Symbol(x)");
  });

  test("does not expose inherited properties", () => {
    expect(render("{{secret}}|{{constructor}}|{{__proto__}}", Object.create({ secret: "hidden" }))).toBe("||");
  });

  for (const value of [{}, [], () => 1, new Date()]) {
    test(`rejects non-scalar ${String(value)}`, () => {
      for (const tag of ["{{value}}", "{{{value}}}"]) {
        expect(() => render(`x\n  ${tag}`, { value }))
          .toThrow(/Cannot render "value" as scalar text .*line 2, column 3/);
      }
    });
  }
});

describe("blocks", () => {
  test("implements conditional truthiness", () => {
    for (const value of ["", 0, -0, false, null, undefined, [], NaN]) {
      expect(render("{{#if value}}yes{{else}}no{{/if}}", { value })).toBe("no");
    }
    for (const value of ["0", 1, -1, true, {}, [false], () => 0]) {
      expect(render("{{#if value}}yes{{else}}no{{/if}}", { value })).toBe("yes");
    }
    expect(render("{{#if no}}hidden{{/if}}", {})).toBe("");
  });

  test("nests if blocks and ignores unrenderable values in inactive branches", () => {
    const template = "{{#if a}}A{{#if b}}B{{else}}C{{/if}}{{else}}{{bad}}{{/if}}";
    expect(render(template, { a: true, b: false, bad: {} })).toBe("AC");
  });

  test("iterates primitives and uses root fallback", () => {
    expect(render("{{#each items}}{{@index}}={{this}}/{{title}};{{/each}}", {
      items: ["a", 0, false, null], title: "root",
    })).toBe("0=a/root;1=0/root;2=false/root;3=/root;");
  });

  test("local values override root unless undefined; this never falls back", () => {
    expect(render("{{#each items}}{{name}}:{{this.name}};{{/each}}", {
      name: "root", items: [{ name: "local" }, {}, { name: null }, { name: false }],
    })).toBe("local:local;root:;:;false:false;");
  });

  test("nested loops restore item and index, with if preserving context", () => {
    const template = "{{#each groups}}[{{@index}}/{{name}}:{{#each this.items}}{{#if this}}{{@index}}={{this}}/{{title}};{{/if}}{{else}}empty-{{name}}{{/each}}:{{@index}}/{{name}}]{{/each}}";
    expect(render(template, {
      title: "R", groups: [{ name: "A", items: ["x", "y"] }, { name: "B", items: [] }],
    })).toBe("[0/A:0=x/R;1=y/R;:0/A][1/B:empty-B:1/B]");
  });

  test("each else handles empty and non-array inputs", () => {
    for (const items of [[], undefined, null, false, 1, "abc", {}]) {
      expect(render("{{#each items}}item{{else}}empty{{/each}}", { items })).toBe("empty");
    }
    expect(render("{{#each items}}item{{/each}}", {})).toBe("");
  });
});

describe("syntax diagnostics", () => {
  const cases: [string, RegExp][] = [
    ["{{#unknown x}}", /Unknown block/],
    ["{{#if x}}{{/each}}", /Mismatched closing tag/],
    ["{{/if}}", /Unexpected closing tag/],
    ["{{#if x}}", /Unclosed if block/],
    ["{{#each x}}", /Unclosed each block/],
    ["{{#if x}}{{else}}{{else}}{{/if}}", /Duplicate else/],
    ["{{else}}", /else outside a block/],
    ["{{unfinished", /Unclosed tag/],
    ["{{{unfinished}}", /Unclosed tag/],
    ["{{#if}}", /Invalid path/],
    ["{{}}", /Invalid path/],
    ["{{a..b}}", /Invalid path/],
  ];
  for (const [template, message] of cases) {
    test(template, () => {
      expect(() => render(template, {})).toThrow(message);
      expect(() => render(template, {})).toThrow(/line \d+, column \d+/);
    });
  }
  test("reports exact location and parses inactive branches", () => {
    expect(() => render("first\r\n  {{else}}", {})).toThrow("line 2, column 3");
    expect(() => render("{{#if missing}}\n{{#bad x}}{{/if}}", {})).toThrow("line 2, column 1");
  });
});
