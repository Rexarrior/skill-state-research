import { describe, expect, test } from "bun:test";
import { render } from "../src/engine";

describe("interpolation", () => {
  test("escapes all HTML special characters and supports raw text", () => {
    expect(render("{{value}}|{{{value}}}", { value: `&<>"'` })).toBe("&amp;&lt;&gt;&quot;&#39;|&<>\"'");
  });
  test("preserves whitespace, removes comments, and handles missing values", () => {
    expect(render(" a\r\n\t{{! ignored }}{{ missing }}{{nil}} b\n", { nil: null })).toBe(" a\r\n\t b\n");
    expect(render("{{a.b}}/{{a.c}}/{{zero}}/{{no}}", { a: { b: "ok" }, zero: 0, no: false })).toBe("ok//0/false");
    expect(render("{{this}}", 12n)).toBe("12");
  });
  test("does not expose inherited properties", () => {
    expect(render("{{toString}}{{constructor}}{{secret}}", Object.create({ secret: "hidden" }))).toBe("");
  });
  test.each([{}, [], () => 1, Symbol("x")].map(value => [value]))("rejects non-scalar values %p", value => {
    expect(() => render("\n{{value}}", { value })).toThrow(/Cannot render .*scalar text at line 2, column 1/);
    expect(() => render("{{{value}}}", { value })).toThrow(/Cannot render/);
  });
});

describe("blocks and scope", () => {
  test.each(["", 0, false, null, undefined, [], NaN].map(value => [value]))("false condition %p", value => {
    expect(render("{{#if value}}T{{else}}F{{/if}}", { value })).toBe("F");
  });
  test.each(["0", 1, true, {}, [0]].map(value => [value]))("true condition %p", value => {
    expect(render("{{#if value}}T{{else}}F{{/if}}", { value })).toBe("T");
  });
  test("nested conditionals", () => {
    expect(render("{{#if a}}A{{#if b}}B{{else}}C{{/if}}{{else}}D{{/if}}", { a: true, b: false })).toBe("AC");
  });
  test("array iteration, local precedence, and root fallback", () => {
    expect(render("{{#each items}}{{@index}}:{{name}}/{{title}}/{{this.name}};{{/each}}", {
      name: "root", title: "T", items: [{ name: "local" }, {}],
    })).toBe("0:local/T/local;1:root/T/;");
    expect(render("{{#each items}}{{this}} {{/each}}", { items: [0, false, "hi", null] })).toBe("0 false hi  ");
  });
  test("nested loops restore outer item and index", () => {
    expect(render("{{#each groups}}[{{@index}}:{{#each this.items}}{{@index}}={{this}}/{{title}};{{/each}}:{{this.name}}:{{@index}}]{{/each}}", {
      title: "R", groups: [{ name: "A", items: ["x", "y"] }, { name: "B", items: ["z"] }],
    })).toBe("[0:0=x/R;1=y/R;:A:0][1:0=z/R;:B:1]");
  });
  test.each([undefined, null, [], {}, "abc", 1].map(value => [value]))("each else for %p", items => {
    expect(render("{{#each items}}X{{else}}E{{/each}}", { items })).toBe("E");
  });
  test("empty nested loop keeps the enclosing scope in else", () => {
    expect(render("{{#each items}}{{#each this.empty}}X{{else}}{{this.name}}:{{@index}}{{/each}}{{/each}}", { items: [{ name: "A", empty: [] }] })).toBe("A:0");
  });
  test("missing branches emit nothing", () => {
    expect(render("{{#if absent}}X{{/if}}{{#each absent}}Y{{/each}}", {})).toBe("");
  });
});

describe("syntax diagnostics", () => {
  test.each([
    ["{{#unknown x}}", /Unknown or invalid block/],
    ["{{#if x}}{{/each}}", /Mismatched closing tag/],
    ["{{/if}}", /Unexpected closing tag/],
    ["{{#if x}}", /Unclosed if block/],
    ["{{#each x}}", /Unclosed each block/],
    ["{{#if x}}{{else}}{{else}}{{/if}}", /Duplicate else/],
    ["{{else}}", /else outside a block/],
    ["{{foo", /Unclosed tag/],
    ["{{{foo}}", /Unclosed tag/],
    ["{{}}", /Invalid path/],
  ] as const)("rejects %s", (template, message) => {
    expect(() => render(template, {})).toThrow(message);
    expect(() => render(template, {})).toThrow(/line \d+, column \d+/);
  });
  test("reports exact location and validates skipped branches", () => {
    expect(() => render("first\n  {{else}}", {})).toThrow("line 2, column 3");
    expect(() => render("{{#if absent}}{{#bad x}}{{/if}}", {})).toThrow(/Unknown/);
  });
});
