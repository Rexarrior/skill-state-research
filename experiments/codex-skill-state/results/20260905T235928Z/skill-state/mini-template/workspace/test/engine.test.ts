import { describe, expect, test } from "bun:test";
import { render } from "../src/engine";

describe("render", () => {
  test("escapes interpolation and preserves raw values", () => {
    expect(render(`{{value}}|{{{value}}}`, { value: `&<>"'` }))
      .toBe(`&amp;&lt;&gt;&quot;&#39;|&<>"'`);
  });

  test("renders missing values as empty strings", () => {
    expect(render("a{{missing.deep}}b", {})).toBe("ab");
  });

  test("supports nested if blocks and specified truthiness", () => {
    expect(render("{{#if a}}A{{#if b}}B{{else}}C{{/if}}{{else}}D{{/if}}", { a: 1, b: 0 })).toBe("AC");
    for (const value of ["", 0, false, null, undefined, []]) {
      expect(render("{{#if value}}yes{{else}}no{{/if}}", { value })).toBe("no");
    }
    expect(render("{{#if value}}yes{{else}}no{{/if}}", { value: {} })).toBe("yes");
  });

  test("iterates arrays with locals, root fallback, and nesting", () => {
    const template = "{{#each groups}}[{{title}}/{{site}}:{{#each items}}{{@index}}={{this}};{{else}}empty{{/each}}]{{/each}}";
    const data = { site: "HQ", groups: [{ title: "A", items: ["x", "y"] }, { title: "B", items: [] }] };
    expect(render(template, data)).toBe("[A/HQ:0=x;1=y;][B/HQ:empty]");
  });

  test("each else handles missing, non-array, and empty arrays", () => {
    expect(render("{{#each items}}x{{else}}none{{/each}}", { items: [] })).toBe("none");
    expect(render("{{#each items}}x{{else}}none{{/each}}", { items: "no" })).toBe("none");
  });

  test("removes comments and preserves surrounding whitespace", () => {
    expect(render(" a \n{{! ignored }}\n b ", {})).toBe(" a \n\n b ");
  });

  test("rejects nonscalar interpolation", () => {
    expect(() => render("line\n{{value}}", { value: {} })).toThrow("line 2, column 1");
    expect(() => render("{{value}}", { value: {} })).toThrow("not scalar");
  });

  test("reports structural errors with locations", () => {
    const cases = [
      ["x\n{{else}}", "else outside a block at line 2, column 1"],
      ["{{#if x}}{{else}}{{else}}{{/if}}", "Duplicate else"],
      ["{{#if x}}{{/each}}", "Mismatched close"],
      ["{{#wat x}}", "Unknown or malformed block"],
      ["{{#each x}}", "Unclosed each block"],
      ["{{/if}}", "without an open block"],
    ];
    for (const [template, message] of cases) {
      expect(() => render(template, {})).toThrow(message);
    }
  });
});
