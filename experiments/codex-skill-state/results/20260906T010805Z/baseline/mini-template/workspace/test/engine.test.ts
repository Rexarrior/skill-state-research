import { describe, expect, test } from "bun:test";
import { render, TemplateError } from "../src/engine";

describe("interpolation", () => {
  test("escapes HTML and preserves surrounding whitespace", () => {
    expect(render("  {{ user.name }}\n", { user: { name: `&<>\"'` } })).toBe(
      "  &amp;&lt;&gt;&quot;&#39;\n",
    );
  });

  test("supports raw interpolation and missing values", () => {
    expect(render("{{{html}}}|{{missing}}", { html: "<b>ok</b>" })).toBe("<b>ok</b>|");
  });

  test("rejects non-scalar values with their source location", () => {
    expect(() => render("x\n{{value}}", { value: {} })).toThrow(
      'Value at "value" is not scalar text at line 2, column 1',
    );
  });

  test("reports columns by Unicode character", () => {
    expect(() => render("🙂 {{value}}", { value: {} })).toThrow(
      'Value at "value" is not scalar text at line 1, column 3',
    );
  });

  test("does not traverse inherited properties", () => {
    const data = Object.create({ secret: "no" }) as Record<string, unknown>;
    expect(render("{{secret}}", data)).toBe("");
  });
});

describe("blocks", () => {
  test("implements the specified truthiness", () => {
    for (const value of ["", 0, -0, 0n, false, null, undefined, []]) {
      expect(render("{{#if value}}yes{{else}}no{{/if}}", { value })).toBe("no");
    }
    for (const value of ["0", 1, true, {}, [0], Number.NaN]) {
      expect(render("{{#if value}}yes{{else}}no{{/if}}", { value })).toBe("yes");
    }
  });

  test("supports nested if blocks", () => {
    const template = "{{#if a}}A{{#if b}}B{{else}}C{{/if}}{{else}}D{{/if}}";
    expect(render(template, { a: true, b: false })).toBe("AC");
    expect(render(template, { a: false, b: true })).toBe("D");
  });

  test("iterates arrays with local values, indexes, root fallback, and else", () => {
    const template = "{{#each users}}[{{@index}}:{{name}}/{{site}}]{{else}}empty{{/each}}";
    expect(render(template, { site: "root", users: [{ name: "Ada" }, { name: "Lin" }] })).toBe(
      "[0:Ada/root][1:Lin/root]",
    );
    expect(render(template, { site: "root", users: [] })).toBe("empty");
    expect(render(template, { site: "root", users: "not an array" })).toBe("empty");
  });

  test("supports nested loops and this paths", () => {
    const template = "{{#each rows}}{{#each this}}({{@index}}={{this.name}}/{{title}}){{/each}}{{/each}}";
    const data = { title: "T", rows: [[{ name: "a" }, { name: "b" }], [{ name: "c" }]] };
    expect(render(template, data)).toBe("(0=a/T)(1=b/T)(0=c/T)");
  });
});

describe("syntax errors", () => {
  test("comments emit nothing", () => {
    expect(render("a{{! ignored }}b", {})).toBe("ab");
  });

  test.each([
    ["{{#wat x}}{{/wat}}", "Unknown block", 1, 1],
    ["{{else}}", "else used outside a block", 1, 1],
    ["{{#if x}}{{else}}{{else}}{{/if}}", "Duplicate else", 1, 18],
    ["{{#if x}}{{/each}}", "Mismatched closing block", 1, 10],
    ["{{/if}}", "Unexpected closing block", 1, 1],
    ["before\n{{#if x}}", "Unclosed if block", 2, 1],
    ["before\n{{name", "Unclosed tag", 2, 1],
  ])("reports %s", (template, message, line, column) => {
    try {
      render(template as string, {});
      throw new Error("expected render to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(TemplateError);
      expect((error as Error).message).toContain(message as string);
      expect((error as TemplateError).line).toBe(line);
      expect((error as TemplateError).column).toBe(column);
    }
  });
});
