import { describe, expect, test } from "bun:test";
import { render } from "../src/engine";

describe("render", () => {
  test("escapes scalar values and preserves surrounding whitespace", () => {
    expect(render(" \n{{ x }}\t{{{x}}}\r\n", { x: `&<>"'` })).toBe(" \n&amp;&lt;&gt;&quot;&#39;\t&<>\"'\r\n");
    expect(render("{{a}}|{{b}}|{{c}}|{{d}}", { a: 0, b: false, c: 12n, d: "" })).toBe("0|false|12|");
    expect(render("{{a.b}}/{{x}}/{{nil}}", { nil: null })).toBe("//");
    expect(render("{{this}}", "root")).toBe("root");
    expect(render("{{this}}", undefined)).toBe("");
  });

  test("conditionals implement all specified false values", () => {
    for (const x of ["", 0, false, null, undefined, []]) {
      expect(render("{{#if x}}yes{{else}}no{{/if}}", { x })).toBe("no");
    }
    for (const x of ["0", 1, true, {}, [0]]) {
      expect(render("{{#if x}}yes{{else}}no{{/if}}", { x })).toBe("yes");
    }
    expect(render("{{#if missing}}no{{/if}}", {})).toBe("");
    expect(render("{{#if a}}A{{#if b}}B{{else}}C{{/if}}{{else}}D{{/if}}", { a: true })).toBe("AC");
  });

  test("loops restore context and fall back to root", () => {
    const template = "{{#each groups}}{{@index}}:{{name}}/{{root}}[{{#each members}}{{@index}}={{this}}/{{root}};{{/each}}]{{name}}:{{@index}};{{/each}}";
    expect(render(template, { root: "R", groups: [{ name: "A", members: ["x", "y"] }, { name: "B", members: ["z"] }] }))
      .toBe("0:A/R[0=x/R;1=y/R;]A:0;1:B/R[0=z/R;]B:1;");
    expect(render("{{#each xs}}{{name}}/{{this.name}};{{/each}}", { name: "root", xs: [{}, { name: null }, { name: undefined }] })).toBe("root/;/;/;");
    expect(render("{{#each xs}}{{#if this}}{{this}}{{else}}false{{/if}}{{/each}}", { xs: [0, 2] })).toBe("false2");
  });

  test("each else handles absent and non-array values", () => {
    for (const xs of [[], undefined, null, {}, "text", 0]) {
      expect(render("{{#each xs}}bad{{else}}empty{{/each}}", { xs })).toBe("empty");
    }
    expect(render("{{#each xs}}{{#each missing}}bad{{else}}{{this}}:{{@index}}{{/each}}{{/each}}", { xs: ["x"] })).toBe("x:0");
  });

  test("comments and own properties", () => {
    expect(render("a{{! ignored #if x }} b", {})).toBe("a b");
    expect(render("{{toString}}/{{constructor}}/{{a.0}}", { a: ["ok"] })).toBe("//ok");
    expect(render("{{x}}", Object.create({ x: "inherited" }))).toBe("");
  });

  test("rejects non-scalars with locations, including raw interpolation", () => {
    for (const x of [{}, [], () => 1, Symbol("x")]) {
      expect(() => render("a\n  {{x}}", { x })).toThrow(/scalar text.*line 2, column 3/);
      expect(() => render("{{{x}}}", { x })).toThrow("scalar text");
    }
  });

  test("structural errors are detected even in inactive branches", () => {
    const cases: [string, RegExp][] = [
      ["{{#wat x}}{{/wat}}", /Unknown block/],
      ["{{#if x}}{{/each}}", /Mismatched close/],
      ["{{/if}}", /Unexpected close/],
      ["{{#if x}}", /Unclosed if block/],
      ["{{else}}", /else outside/],
      ["{{#each x}}{{else}}{{else}}{{/each}}", /Duplicate else/],
      ["{{x", /Unclosed tag/],
      ["{{{x}}", /Unclosed tag/],
      ["{{#if}}", /Invalid path/],
      ["{{a..b}}", /Invalid path/],
      ["{{#if missing}}{{#unknown x}}{{/unknown}}{{/if}}", /Unknown block/],
    ];
    for (const [template, message] of cases) {
      expect(() => render(`\n ${template}`, {})).toThrow(message);
      expect(() => render(`\n ${template}`, {})).toThrow(/line \d+, column \d+/);
    }
    expect(() => render("first\n  {{else}}", {})).toThrow("line 2, column 3");
  });
});
