import { describe, expect, test } from "bun:test";
import { render, TemplateError } from "../src/engine.ts";

describe("render", () => {
  test("interpolates escaped and raw scalar values", () => {
    const data = { value: `&<>"'`, zero: 0, no: false };
    expect(render("{{value}}|{{{value}}}|{{zero}}|{{no}}|{{missing}}", data))
      .toBe("&amp;&lt;&gt;&quot;&#39;|&<>\"'|0|false|");
  });

  test("preserves whitespace and removes comments", () => {
    expect(render(" a\n {{! ignored }} \t b ", {})).toBe(" a\n  \t b ");
  });

  test("supports nested conditionals and specified truthiness", () => {
    const falseValues = ["", 0, false, null, undefined, []];
    for (const value of falseValues) {
      expect(render("{{#if value}}yes{{else}}no{{/if}}", { value })).toBe("no");
    }
    expect(render("{{#if value}}A{{#if nested}}B{{else}}C{{/if}}{{/if}}", {
      value: {}, nested: true,
    })).toBe("AB");
  });

  test("iterates arrays with item, index, item paths, and root fallback", () => {
    const template = "{{#each users}}[{{@index}}:{{name}}/{{site}}]{{else}}empty{{/each}}";
    expect(render(template, { site: "HQ", users: [{ name: "Ada" }, { name: "Lin" }] }))
      .toBe("[0:Ada/HQ][1:Lin/HQ]");
    expect(render(template, { site: "HQ", users: [] })).toBe("empty");
  });

  test("supports nested loop contexts", () => {
    const template = "{{#each groups}}{{name}}:{{#each members}}{{name}}@{{@index}}/{{/each}};{{/each}}";
    expect(render(template, {
      groups: [{ name: "g", members: [{ name: "a" }, { name: "b" }] }],
    })).toBe("g:a@0/b@1/;");
  });

  test("rejects values that are not scalar text", () => {
    expect(() => render("line\n{{value}}", { value: { nested: true } })).toThrow(
      "Cannot render an object value as scalar text at line 2, column 1",
    );
    expect(() => render("{{value}}", { value: () => 1 })).toThrow("Cannot render a function");
  });

  test.each([
    ["{{#wat x}}{{/wat}}", "Unknown block", 1, 1],
    ["x\n{{else}}", "Else outside a block", 2, 1],
    ["{{#if x}}{{else}}{{else}}{{/if}}", "Duplicate else", 1, 18],
    ["{{#if x}}{{/each}}", "Mismatched closing block", 1, 10],
    ["{{#if x}}", "Unclosed if block", 1, 1],
    ["abc {{name", "Unclosed tag", 1, 5],
  ])("reports structural error for %s", (template, message, line, column) => {
    try {
      render(template as string, {});
      throw new Error("Expected render to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(TemplateError);
      expect((error as Error).message).toContain(message as string);
      expect(error).toMatchObject({ line, column });
    }
  });
});
