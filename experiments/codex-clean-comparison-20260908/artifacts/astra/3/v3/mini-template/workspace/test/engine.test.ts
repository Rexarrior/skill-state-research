import { describe, expect, test } from "bun:test";
import { render } from "../src/engine";

describe("render", () => {
  test("preserves text, escapes all HTML characters, and supports raw values", () => {
    expect(render(" \n{{ value }}\t{{{value}}}\n", { value: `&<>"'` }))
      .toBe(" \n&amp;&lt;&gt;&quot;&#39;\t&<>\"'\n");
    expect(render("", {})).toBe("");
    expect(render("a\r\nb\t ", null)).toBe("a\r\nb\t ");
  });
  test("scalar, missing, own, and root paths", () => {
    expect(render("{{a.b}}|{{missing}}|{{nil}}|{{false}}|{{zero}}", {
      a: { b: "ok" }, nil: null, false: false, zero: 0,
    })).toBe("ok|||false|0");
    expect(render("{{this}}", 12n)).toBe("12");
    expect(render("{{toString}}", {})).toBe("");
    expect(render("{{x}}", Object.create({ x: "inherited" }))).toBe("");
  });
  test("truthiness and nested conditionals", () => {
    for (const value of ["", 0, -0, 0n, false, null, undefined, []]) {
      expect(render("{{#if value}}T{{else}}F{{/if}}", { value })).toBe("F");
    }
    for (const value of ["0", 1, 1n, true, {}, [0], NaN, () => 1]) {
      expect(render("{{#if value}}T{{else}}F{{/if}}", { value })).toBe("T");
    }
    expect(render("{{#if a}}a{{#if b}}b{{else}}c{{/if}}{{else}}d{{/if}}", { a: true }))
      .toBe("ac");
  });
  test("loops use local values, root fallback, and restore nesting context", () => {
    const template = "{{#each groups}}{{@index}}:{{name}}/{{title}}[{{#each items}}{{@index}}={{this}};{{else}}none{{/each}}]{{@index}};{{/each}}";
    expect(render(template, { title: "root", groups: [{ name: "A", items: ["x", "y"] }, { name: "B", items: [] }] }))
      .toBe("0:A/root[0=x;1=y;]0;1:B/root[none]1;");
    expect(render("{{#each items}}{{name}}:{{this.name}};{{/each}}", { name: "root", items: [{}, { name: null }] }))
      .toBe("root:;:;");
    expect(render("{{#each items}}{{a.b}}{{/each}}", { a: { b: "root" }, items: [{ a: {} }] })).toBe("root");
  });
  test("each else and comments", () => {
    for (const items of [[], null, undefined, {}, "abc", 0]) {
      expect(render("{{#each items}}x{{else}}empty{{/each}}", { items })).toBe("empty");
    }
    expect(render("a{{! ignored }} b", {})).toBe("a b");
    expect(render("{{#if absent}}{{bad}}{{/if}}", { bad: {} })).toBe("");
  });
  test("non-scalar values fail clearly for both interpolation forms", () => {
    for (const value of [{}, [], () => 1]) {
      for (const tag of ["{{value}}", "{{{value}}}"]) {
        expect(() => render(`text\n  ${tag}`, { value })).toThrow(/non-scalar.*line 2, column 3/);
      }
    }
  });
  test("structural errors include source positions, even in inactive branches", () => {
    for (const [source, message] of [
      ["{{#unknown x}}", "Unknown block"],
      ["{{/if}}", "Unexpected closing"],
      ["{{#if x}}{{/each}}", "Mismatched closing"],
      ["{{#each x}}", "Unclosed each"],
      ["{{#if x}}{{else}}{{else}}{{/if}}", "Duplicate else"],
      ["{{else}}", "else outside"],
      ["{{x", "Unclosed tag"],
      ["{{#if}}", "Invalid path"],
      ["{{}}", "Invalid path"],
      ["{{#if missing}}{{#oops x}}{{/if}}", "Unknown block"],
    ]) {
      expect(() => render(source!, {})).toThrow(message!);
      expect(() => render(source!, {})).toThrow(/line \d+, column \d+/);
    }
    expect(() => render("a\n  {{else}}", {})).toThrow("line 2, column 3");
  });
});
