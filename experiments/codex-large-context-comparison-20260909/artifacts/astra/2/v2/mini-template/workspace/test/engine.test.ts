import { describe, expect, test } from "bun:test";
import { render } from "../src/engine.ts";

describe("interpolation", () => {
  test("escapes all HTML special characters and supports raw values", () => {
    expect(render("{{ value }}|{{{value}}}", { value: `&<>"'` })).toBe("&amp;&lt;&gt;&quot;&#39;|&<>\"'");
  });
  test("preserves whitespace and omits comments and missing values", () => {
    expect(render(" a\r\n{{! ignored }}\t{{missing}}/{{nil}}\n", { nil: null })).toBe(" a\r\n\t/\n");
  });
  test("renders scalar values and own dotted properties", () => {
    expect(render("{{a.b.0}} {{n}} {{f}} {{big}} {{symbol}}", {
      a: { b: ["yes"] }, n: 0, f: false, big: 12n, symbol: Symbol("x"),
    })).toBe("yes 0 false 12 Symbol(x)");
    expect(render("{{toString}} {{hidden}}", Object.create({ hidden: "secret" }))).toBe(" ");
    expect(render("{{this}}/{{@index}}", "root")).toBe("root/");
  });
  test("rejects objects, arrays, and functions in both interpolation forms", () => {
    for (const value of [{}, [], () => "x"]) {
      for (const template of ["\n  {{value}}", "\n  {{{value}}}"]) {
        expect(() => render(template, { value })).toThrow(/non-scalar.*value.*line 2, column 3/);
      }
    }
  });
});

describe("blocks", () => {
  test("implements truthiness", () => {
    for (const value of ["", 0, false, null, undefined, [], NaN]) {
      expect(render("{{#if value}}yes{{else}}no{{/if}}", { value })).toBe("no");
    }
    for (const value of ["0", 1, true, {}, [0]]) {
      expect(render("{{#if value}}yes{{else}}no{{/if}}", { value })).toBe("yes");
    }
  });
  test("supports nested conditions and optional else", () => {
    const template = "{{#if a}}A{{#if b}}B{{else}}C{{/if}}{{else}}D{{/if}}";
    expect(render(template, { a: true, b: false })).toBe("AC");
    expect(render(template, { a: false })).toBe("D");
    expect(render("{{#if a}}x{{/if}}", {})).toBe("");
  });
  test("nested loops restore context and fall back to root", () => {
    const template = "{{#each groups}}[{{@index}}:{{name}}:{{title}}{{#each entries}}({{@index}}={{this}}/{{title}}){{/each}}:{{@index}}:{{this.name}}]{{/each}}";
    expect(render(template, { title: "root", groups: [
      { name: "a", entries: ["x", "y"] }, { name: "b", entries: ["z"] },
    ] })).toBe("[0:a:root(0=x/root)(1=y/root):0:a][1:b:root(0=z/root):1:b]");
  });
  test("uses each else for empty or non-array values", () => {
    for (const items of [[], undefined, null, {}, "text", 1]) {
      expect(render("{{#each items}}x{{else}}empty{{/each}}", { items })).toBe("empty");
    }
  });
  test("missing complete item paths fall back, null and undefined stay empty", () => {
    expect(render("{{#each items}}{{a.b}}/{{name}};{{/each}}", {
      a: { b: "root" }, name: "ROOT", items: [{ a: {}, name: null }, { name: undefined }],
    })).toBe("root/;root/;");
  });
  test("conditions retain loop scope and nested each else retains parent scope", () => {
    expect(render("{{#each items}}{{#if this.ok}}{{@index}}{{#each this.children}}x{{else}}{{this.name}}{{/each}}{{/if}}{{/each}}", {
      items: [{ ok: true, name: "a", children: [] }, { ok: false }],
    })).toBe("0a");
  });
});

describe("syntax errors", () => {
  const cases: [string, RegExp][] = [
    ["{{#unknown a}}{{/unknown}}", /Unknown block/],
    ["{{#if a}}{{/each}}", /Mismatched closing tag/],
    ["{{/if}}", /Unexpected closing tag/],
    ["{{#if a}}", /Unclosed if block/],
    ["{{#each a}}", /Unclosed each block/],
    ["{{else}}", /else outside/],
    ["{{#if a}}{{else}}{{else}}{{/if}}", /Duplicate else/],
    ["{{#each a}}{{else}}{{else}}{{/each}}", /Duplicate else/],
    ["{{value", /Unclosed tag/],
    ["{{{value}}", /Unclosed tag/],
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
  test("reports exact location and checks skipped branches", () => {
    expect(() => render("first\n  {{else}}", {})).toThrow("line 2, column 3");
    expect(() => render("{{#if missing}}{{#bad x}}{{/bad}}{{/if}}", {})).toThrow(/Unknown block/);
  });
});
