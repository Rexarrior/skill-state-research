import { describe, expect, test } from "bun:test";
import { render } from "./engine";

describe("render", () => {
  test("interpolates nested paths and escapes all required characters", () => {
    expect(render("Hello {{user.name}}: {{value}}", {
      user: { name: "Ada" },
      value: `&<>\"'`,
    })).toBe("Hello Ada: &amp;&lt;&gt;&quot;&#39;");
    expect(render("{{{html}}}", { html: "<b>safe</b>" })).toBe("<b>safe</b>");
    expect(render("x{{missing.path}}y", {})).toBe("xy");
  });

  test("preserves whitespace and removes comments", () => {
    expect(render("  a\n{{! ignored }}\n b  ", {})).toBe("  a\n\n b  ");
  });

  test("uses the specified truthiness rules and supports nested if blocks", () => {
    for (const value of ["", 0, false, null, undefined, []]) {
      expect(render("{{#if value}}yes{{else}}no{{/if}}", { value })).toBe("no");
    }
    for (const value of ["x", 1, true, {}, [0], Number.NaN]) {
      expect(render("{{#if value}}yes{{else}}no{{/if}}", { value })).toBe("yes");
    }
    expect(render("{{#if a}}A{{#if b}}B{{else}}C{{/if}}{{/if}}", { a: 1, b: 0 }))
      .toBe("AC");
  });

  test("iterates, exposes loop variables, and falls back to root paths", () => {
    expect(render(
      "{{#each users}}[{{@index}}:{{name}}/{{title}}/{{this.name}}]{{else}}empty{{/each}}",
      { title: "team", users: [{ name: "A" }, { name: "B" }] },
    )).toBe("[0:A/team/A][1:B/team/B]");
    expect(render("{{#each users}}x{{else}}empty{{/each}}", { users: [] })).toBe("empty");
    expect(render("{{#each users}}x{{else}}empty{{/each}}", { users: "no" })).toBe("empty");
  });

  test("supports nested loops", () => {
    expect(render(
      "{{#each rows}}{{name}}={{#each this.cells}}{{@index}}:{{this}}/{{name}};{{/each}}|{{/each}}",
      { name: "root", rows: [{ name: "r1", cells: ["a", "b"] }] },
    )).toBe("r1=0:a/root;1:b/root;|");
  });

  test("rejects non-scalar interpolation", () => {
    expect(() => render("{{item}}", { item: {} })).toThrow(/not scalar.*line 1, column 1/i);
    expect(() => render("{{items}}", { items: [] })).toThrow(/not scalar/i);
  });

  test("reports structural errors with line and column", () => {
    expect(() => render("one\n{{#wat x}}", {})).toThrow(/Unknown block.*line 2, column 1/);
    expect(() => render("{{#if x}}{{/each}}", {})).toThrow(/Mismatched.*line 1, column 10/);
    expect(() => render("{{#if x}}", {})).toThrow(/Unclosed #if.*line 1, column 1/);
    expect(() => render("{{else}}", {})).toThrow(/else outside.*line 1, column 1/);
    expect(() => render("{{#if x}}{{else}}{{else}}{{/if}}", {})).toThrow(/Duplicate else.*column 18/);
    expect(() => render("{{/if}}", {})).toThrow(/without an open block.*line 1, column 1/);
  });
});
