import { describe, expect, test } from "bun:test";
import { render, TemplateError } from "../src/engine.ts";

describe("interpolation", () => {
  test("escapes HTML and supports unescaped values", () => {
    const value = `&<>\"'`;
    expect(render("{{value}} / {{{value}}}", { value })).toBe(
      `&amp;&lt;&gt;&quot;&#39; / &<>\"'`,
    );
  });

  test("renders missing values as empty strings and preserves whitespace", () => {
    expect(render("  a\n{{missing}} b  ", {})).toBe("  a\n b  ");
  });

  test("rejects objects and functions as text", () => {
    expect(() => render("{{value}}", { value: {} })).toThrow("Cannot render non-scalar");
    expect(() => render("{{value}}", { value: () => 1 })).toThrow("Cannot render non-scalar");
  });

  test("comments emit nothing", () => {
    expect(render("a{{! ignored }}b", {})).toBe("ab");
  });
});

describe("blocks", () => {
  test("uses the specified truthiness rules", () => {
    const values = ["", 0, 0n, false, null, undefined, [], "0", {}, [0], Number.NaN];
    expect(values.map((value) => render("{{#if value}}T{{else}}F{{/if}}", { value }))).toEqual([
      "F", "F", "F", "F", "F", "F", "F", "T", "T", "T", "T",
    ]);
  });

  test("supports nested if blocks", () => {
    const template = "{{#if a}}A{{#if b}}B{{else}}C{{/if}}{{else}}D{{/if}}";
    expect(render(template, { a: true, b: false })).toBe("AC");
    expect(render(template, { a: false, b: true })).toBe("D");
  });

  test("iterates arrays with item, index, root fallback, and nesting", () => {
    const template = "{{#each groups}}[{{name}}/{{title}}:{{#each items}}{{@index}}={{this}};{{else}}empty{{/each}}]{{/each}}";
    expect(render(template, {
      title: "root",
      groups: [
        { name: "a", items: ["x", "y"] },
        { name: "b", items: [] },
      ],
    })).toBe("[a/root:0=x;1=y;][b/root:empty]");
  });

  test("each else is used for missing, non-array, and empty values", () => {
    expect(render("{{#each x}}bad{{else}}empty{{/each}}", { x: [] })).toBe("empty");
    expect(render("{{#each x}}bad{{else}}empty{{/each}}", { x: 1 })).toBe("empty");
    expect(render("{{#each x}}bad{{else}}empty{{/each}}", {})).toBe("empty");
  });
});

describe("syntax errors", () => {
  test.each([
    ["{{#wat x}}{{/wat}}", "Unknown block"],
    ["{{else}}", "outside a block"],
    ["{{#if x}}{{else}}{{else}}{{/if}}", "Duplicate else"],
    ["{{#if x}}{{/each}}", "Mismatched closing block"],
    ["{{/if}}", "Unexpected closing block"],
    ["{{#if x}}", "Unclosed if block"],
  ])("rejects malformed template %s", (template, message) => {
    expect(() => render(template, {})).toThrow(message);
  });

  test("reports useful line and column details", () => {
    try {
      render("first\n  {{else}}", {});
      throw new Error("expected render to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(TemplateError);
      expect((error as Error).message).toContain("line 2, column 3");
    }
  });
});
