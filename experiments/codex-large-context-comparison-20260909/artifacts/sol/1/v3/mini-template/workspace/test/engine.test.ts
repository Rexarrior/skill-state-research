import { describe, expect, test } from "bun:test";
import { render, TemplateError } from "../src/engine";

describe("render", () => {
  test("interpolates escaped and raw values and preserves whitespace", () => {
    const data = { value: `<tag a="b">Tom & 'Sue'</tag>` };
    expect(render(" A {{value}} B\n{{{value}}}", data)).toBe(
      " A &lt;tag a=&quot;b&quot;&gt;Tom &amp; &#39;Sue&#39;&lt;/tag&gt; B\n<tag a=\"b\">Tom & 'Sue'</tag>",
    );
  });

  test("renders missing and null interpolation values as empty strings", () => {
    expect(render("{{missing}}/{{nil}}", { nil: null })).toBe("/");
  });

  test("supports nested if blocks and the specified truthiness", () => {
    const template = "{{#if outer}}A{{#if inner}}B{{else}}C{{/if}}{{else}}D{{/if}}";
    expect(render(template, { outer: true, inner: 0 })).toBe("AC");
    expect(render(template, { outer: [], inner: true })).toBe("D");
    expect(render("{{#if value}}T{{else}}F{{/if}}", { value: {} })).toBe("T");
  });

  test("iterates arrays, supports else, root fallback, and nested loops", () => {
    const template = "{{#each groups}}[{{name}}:{{#each items}}{{@index}}={{this}}/{{title}};{{else}}empty{{/each}}]{{else}}none{{/each}}";
    expect(render(template, {
      title: "root",
      groups: [{ name: "one", items: ["a", "b"] }, { name: "two", items: [] }],
    })).toBe("[one:0=a/root;1=b/root;][two:empty]");
    expect(render("{{#each list}}x{{else}}none{{/each}}", { list: "not-array" })).toBe("none");
  });

  test("supports object fields in loop items and explicit this paths", () => {
    expect(render("{{#each users}}{{@index}}:{{name}}={{this.name}};{{/each}}", {
      users: [{ name: "Ada" }],
    })).toBe("0:Ada=Ada;");
  });

  test("removes comments", () => {
    expect(render("a{{! ignored }}b", {})).toBe("ab");
  });

  test("rejects values that are not scalar text", () => {
    expect(() => render("line\n{{value}}", { value: {} })).toThrow("cannot be rendered as scalar text");
    expect(() => render("{{value}}", { value: [] })).toThrow(TemplateError);
  });

  test.each([
    ["{{else}}", "outside a block", 1, 1],
    ["x\n{{#if ok}}a{{else}}b{{else}}c{{/if}}", "Duplicate", 2, 21],
    ["{{#if ok}}{{/each}}", "Mismatched", 1, 11],
    ["{{#wat ok}}x{{/wat}}", "Unknown", 1, 1],
    ["x\n{{#each xs}}", "Unclosed", 2, 1],
  ])("reports structural error for %s", (template, message, line, column) => {
    try {
      render(template as string, { ok: true, xs: [] });
      throw new Error("Expected rendering to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(TemplateError);
      expect((error as Error).message).toContain(message as string);
      expect((error as TemplateError).line).toBe(line);
      expect((error as TemplateError).column).toBe(column);
    }
  });
});
