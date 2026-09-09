import { describe, expect, test } from "bun:test";
import { render, TemplateError } from "../src/engine";

describe("render", () => {
  test("escapes interpolations and leaves triple interpolations raw", () => {
    const value = `&<>"'`;
    expect(render("{{value}}|{{{value}}}", { value })).toBe(
      "&amp;&lt;&gt;&quot;&#39;|&<>\"'",
    );
  });

  test("resolves paths and renders missing and null values as empty", () => {
    expect(render("{{user.name}}/{{missing}}/{{nothing}}", {
      user: { name: "Ada" },
      nothing: null,
    })).toBe("Ada//");
  });

  test("implements the specified truthiness and nested if blocks", () => {
    for (const value of ["", 0, -0, 0n, false, null, undefined, []]) {
      expect(render("{{#if value}}yes{{else}}no{{/if}}", { value })).toBe("no");
    }
    for (const value of ["0", Number.NaN, {}, [0]]) {
      expect(render("{{#if value}}yes{{else}}no{{/if}}", { value })).toBe("yes");
    }
    expect(render("{{#if a}}A{{#if b}}B{{else}}C{{/if}}{{/if}}", {
      a: true,
      b: false,
    })).toBe("AC");
  });

  test("iterates arrays with current values, indices, root fallback, and nesting", () => {
    const template = "{{#each groups}}[{{name}}:{{#each items}}{{@index}}={{this}}/{{title}};{{else}}empty{{/each}}]{{/each}}";
    expect(render(template, {
      title: "root",
      groups: [
        { name: "A", items: ["x", "y"] },
        { name: "B", items: [] },
      ],
    })).toBe("[A:0=x/root;1=y/root;][B:empty]");
  });

  test("preserves whitespace and removes comments", () => {
    expect(render("  a\n{{! ignored }}\t b  ", {})).toBe("  a\n\t b  ");
  });

  test("rejects objects and functions as scalar text", () => {
    expect(() => render("{{value}}", { value: {} })).toThrow(/cannot be rendered as text/);
    expect(() => render("{{{value}}}", { value: () => 1 })).toThrow(/cannot be rendered as text/);
  });

  test("reports structural errors with line and column", () => {
    const cases = [
      ["x\n  {{#wat value}}", /line 2, column 3.*unknown block/],
      ["{{#if a}}{{/each}}", /mismatched closing block/],
      ["{{#if a}}{{else}}{{else}}{{/if}}", /duplicate else/],
      ["{{else}}", /else outside a block/],
      ["{{#each xs}}", /unclosed each block/],
    ] as const;

    for (const [template, message] of cases) {
      expect(() => render(template, {})).toThrow(message);
      try {
        render(template, {});
      } catch (error) {
        expect(error).toBeInstanceOf(TemplateError);
      }
    }
  });
});
