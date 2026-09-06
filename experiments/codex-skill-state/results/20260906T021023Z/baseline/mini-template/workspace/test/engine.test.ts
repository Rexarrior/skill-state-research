import { describe, expect, test } from "bun:test";
import { render, TemplateError } from "../src/engine";

describe("interpolation", () => {
  test("escapes HTML and supports raw values", () => {
    const data = { value: `&<>"'` };
    expect(render("{{value}}|{{{value}}}", data)).toBe("&amp;&lt;&gt;&quot;&#39;|&<>\"'");
  });

  test("resolves nested paths and renders missing values as empty", () => {
    expect(render("{{user.name}}/{{user.missing}}", { user: { name: "Ada" } })).toBe("Ada/");
  });

  test("rejects non-scalar values", () => {
    expect(() => render("x {{user}}", { user: { name: "Ada" } })).toThrow("cannot render \"user\" as scalar text");
  });
});

describe("blocks", () => {
  test("uses the specified truthiness rules", () => {
    for (const value of ["", 0, 0n, false, null, undefined, []]) {
      expect(render("{{#if value}}yes{{else}}no{{/if}}", { value })).toBe("no");
    }
    for (const value of ["0", -1, true, {}, [0]]) {
      expect(render("{{#if value}}yes{{else}}no{{/if}}", { value })).toBe("yes");
    }
  });

  test("iterates with item, index, local paths, root fallback, and nesting", () => {
    const template = "{{#each groups}}[{{name}}:{{#each values}}{{@index}}={{this}}/{{title}};{{else}}empty{{/each}}]{{/each}}";
    const data = {
      title: "root",
      groups: [
        { name: "A", values: ["x", "y"] },
        { name: "B", values: [] },
      ],
    };
    expect(render(template, data)).toBe("[A:0=x/root;1=y/root;][B:empty]");
  });

  test("each else is used for missing and non-array values", () => {
    expect(render("{{#each value}}x{{else}}empty{{/each}}", { value: "no" })).toBe("empty");
    expect(render("{{#each missing}}x{{else}}empty{{/each}}", {})).toBe("empty");
  });

  test("preserves whitespace and removes comments", () => {
    expect(render(" a \n {{! ignored }}\n b ", {})).toBe(" a \n \n b ");
  });
});

describe("syntax errors", () => {
  test.each([
    ["{{#wat x}}{{/wat}}", "unknown block \"wat\""],
    ["{{/if}}", "closing if without an open block"],
    ["{{#if x}}{{/each}}", "expected /if, found /each"],
    ["{{#if x}}{{else}}{{else}}{{/if}}", "duplicate else"],
    ["{{else}}", "else outside a block"],
    ["{{#each xs}}", "unclosed each block"],
    ["{{#}}", "malformed block opening"],
    ["{{/}}", "malformed closing block"],
  ])("reports %s", (template, message) => {
    expect(() => render(template, {})).toThrow(message);
  });

  test("includes line and column", () => {
    try {
      render("first\n  {{else}}", {});
      throw new Error("expected render to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(TemplateError);
      expect((error as Error).message).toContain("line 2, column 3");
    }
  });
});
