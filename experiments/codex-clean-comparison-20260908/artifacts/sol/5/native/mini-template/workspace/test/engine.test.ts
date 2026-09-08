import { describe, expect, test } from "bun:test";
import { render } from "../src/engine.ts";

describe("interpolation", () => {
  test("escapes HTML and supports raw values and missing values", () => {
    const data = { value: `&<>"'`, raw: "<b>ok</b>" };
    expect(render("{{value}} {{{raw}}} [{{missing}}]", data)).toBe(
      "&amp;&lt;&gt;&quot;&#39; <b>ok</b> []",
    );
  });

  test("rejects non-scalar interpolation", () => {
    expect(() => render("before {{user}}", { user: { name: "Ada" } })).toThrow(
      /not scalar text.*line 1, column 8/,
    );
    expect(() => render("{{handler}}", { handler: () => "no" })).toThrow(/not scalar text/);
  });
});

describe("blocks", () => {
  test("implements the specified truthiness", () => {
    for (const value of ["", 0, false, null, undefined, []]) {
      expect(render("{{#if x}}yes{{else}}no{{/if}}", { x: value })).toBe("no");
    }
    for (const value of ["0", true, {}, [0], Number.NaN]) {
      expect(render("{{#if x}}yes{{else}}no{{/if}}", { x: value })).toBe("yes");
    }
  });

  test("supports nested loops, this, index, and root fallback", () => {
    const template =
      "{{#each groups}}({{@index}}:{{name}}/{{title}}:" +
      "{{#each this.items}}[{{@index}}={{this}}/{{title}}]{{else}}empty{{/each}}){{/each}}";
    const data = {
      title: "root",
      groups: [
        { name: "A", items: ["x", "y"] },
        { name: "B", items: [] },
      ],
    };
    expect(render(template, data)).toBe("(0:A/root:[0=x/root][1=y/root])(1:B/root:empty)");
  });

  test("uses each else for empty, missing, and non-array values", () => {
    expect(render("{{#each x}}x{{else}}empty{{/each}}", { x: [] })).toBe("empty");
    expect(render("{{#each x}}x{{else}}empty{{/each}}", {})).toBe("empty");
    expect(render("{{#each x}}x{{else}}empty{{/each}}", { x: 2 })).toBe("empty");
  });
});

describe("parsing", () => {
  test("preserves whitespace and removes comments", () => {
    expect(render(" a\n {{! ignored }} \t b ", {})).toBe(" a\n  \t b ");
  });

  test.each([
    ["{{else}}", /outside.*line 1, column 1/],
    ["{{#if x}}{{else}}{{else}}{{/if}}", /Duplicate.*column 18/],
    ["{{#if x}}\n{{/each}}", /Mismatched.*line 2, column 1/],
    ["x\n{{#each xs}}", /Unclosed.*line 2, column 1/],
    ["{{#wat x}}{{/wat}}", /Unknown or invalid block.*line 1, column 1/],
  ])("reports structural error for %s", (template, pattern) => {
    expect(() => render(template as string, {})).toThrow(pattern as RegExp);
  });
});
