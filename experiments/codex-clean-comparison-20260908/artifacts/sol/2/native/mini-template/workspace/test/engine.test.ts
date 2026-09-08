import { describe, expect, test } from "bun:test";
import { render, TemplateError } from "../src/engine";

describe("interpolation", () => {
  test("escapes HTML and supports raw values", () => {
    const value = `&<>"'`;
    expect(render("{{value}}|{{{value}}}", { value })).toBe("&amp;&lt;&gt;&quot;&#39;|&<>\"'");
  });

  test("resolves dotted paths and renders missing values empty", () => {
    expect(render("{{user.name}}/{{user.missing}}", { user: { name: "Ada" } })).toBe("Ada/");
  });

  test("rejects non-scalar interpolation", () => {
    expect(() => render("x {{user}}", { user: { name: "Ada" } })).toThrow(
      "Value at 'user' is not scalar text at line 1, column 3",
    );
    expect(() => render("{{fn}}", { fn() {} })).toThrow(TemplateError);
  });

  test("preserves surrounding whitespace and removes comments", () => {
    expect(render(" a \n{{! ignored }}\n b ", {})).toBe(" a \n\n b ");
  });
});

describe("blocks", () => {
  test("uses the specified truthiness rules", () => {
    for (const value of ["", 0, false, null, undefined, []]) {
      expect(render("{{#if value}}yes{{else}}no{{/if}}", { value })).toBe("no");
    }
    for (const value of ["x", 1, true, {}, [0]]) {
      expect(render("{{#if value}}yes{{else}}no{{/if}}", { value })).toBe("yes");
    }
  });

  test("supports nested conditionals", () => {
    const template = "{{#if a}}A{{#if b}}B{{else}}C{{/if}}{{else}}D{{/if}}";
    expect(render(template, { a: true, b: false })).toBe("AC");
    expect(render(template, { a: false, b: true })).toBe("D");
  });

  test("iterates arrays with local values, indexes, and root fallback", () => {
    const template = "{{#each users}}[{{@index}}:{{name}}/{{site}}]{{else}}empty{{/each}}";
    expect(render(template, { site: "HQ", users: [{ name: "A" }, { name: "B" }] })).toBe(
      "[0:A/HQ][1:B/HQ]",
    );
    expect(render(template, { site: "HQ", users: [] })).toBe("empty");
  });

  test("supports this, this paths, and nested loops", () => {
    const template = "{{#each groups}}{{name}}:{{#each items}}{{@index}}={{this.name}};{{/each}}{{/each}}";
    expect(
      render(template, { groups: [{ name: "G", items: [{ name: "x" }, { name: "y" }] }] }),
    ).toBe("G:0=x;1=y;");
    expect(render("{{#each values}}{{this}},{{/each}}", { values: [1, 2] })).toBe("1,2,");
  });

  test("treats a missing explicit this path as false", () => {
    expect(
      render("{{#each values}}{{#if this.missing}}yes{{else}}no{{/if}}{{/each}}", {
        values: [{}],
      }),
    ).toBe("no");
  });
});

describe("syntax errors", () => {
  test.each([
    ["{{else}}", "'else' outside a block"],
    ["{{#if ok}}{{else}}{{else}}{{/if}}", "Duplicate 'else'"],
    ["{{#if ok}}{{/each}}", "Mismatched closing block"],
    ["{{/if}}", "without an open block"],
    ["{{#wat x}}{{/wat}}", "Unknown or invalid block 'wat'"],
    ["{{#if ok}}", "Unclosed 'if' block"],
    ["hello {{name", "Unclosed tag"],
  ])("reports %s", (template, message) => {
    expect(() => render(template, {})).toThrow(message);
  });

  test("includes a useful line and column", () => {
    expect(() => render("first\nxx {{else}}", {})).toThrow("at line 2, column 4");
  });
});
