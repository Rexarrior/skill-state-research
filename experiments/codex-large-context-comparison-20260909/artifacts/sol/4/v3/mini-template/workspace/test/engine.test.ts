import { describe, expect, test } from "bun:test";
import { render } from "../src/engine";

describe("render", () => {
  test("escapes interpolations and preserves raw interpolations", () => {
    const data = { value: `&<>"'` };
    expect(render("{{value}}|{{{value}}}", data)).toBe("&amp;&lt;&gt;&quot;&#39;|&<>\"'");
  });

  test("resolves nested paths and renders missing values empty", () => {
    expect(render("Hello {{user.name}}/{{missing}}!", { user: { name: "Ada" } })).toBe(
      "Hello Ada/!",
    );
  });

  test("supports nested if blocks and specified truthiness", () => {
    expect(render("{{#if a}}A{{#if b}}B{{else}}C{{/if}}{{else}}D{{/if}}", { a: 1, b: 0 })).toBe("AC");
    for (const value of ["", 0, false, null, undefined, []]) {
      expect(render("{{#if value}}yes{{else}}no{{/if}}", { value })).toBe("no");
    }
    expect(render("{{#if value}}yes{{else}}no{{/if}}", { value: {} })).toBe("yes");
  });

  test("iterates arrays with this, index, local paths, and root fallback", () => {
    const template = "{{#each users}}[{{@index}}:{{name}}/{{site}}/{{this.name}}]{{else}}empty{{/each}}";
    expect(render(template, { site: "HQ", users: [{ name: "A" }, { name: "B" }] })).toBe(
      "[0:A/HQ/A][1:B/HQ/B]",
    );
    expect(render(template, { site: "HQ", users: [] })).toBe("empty");
  });

  test("supports nested loops", () => {
    const template = "{{#each rows}}{{@index}}={{#each this}}{{@index}}:{{this}};{{/each}}|{{/each}}";
    expect(render(template, { rows: [["a", "b"], ["c"]] })).toBe("0=0:a;1:b;|1=0:c;|");
  });

  test("removes comments without changing surrounding whitespace", () => {
    expect(render(" a \n{{! ignored }}\n b ", {})).toBe(" a \n\n b ");
  });

  test("rejects non-scalar interpolations", () => {
    expect(() => render("x {{user}}", { user: { name: "Ada" } })).toThrow(/not scalar.*line 1, column 3/i);
    expect(() => render("{{fn}}", { fn() {} })).toThrow(/not scalar/i);
  });

  test("reports structural errors with line and column", () => {
    expect(() => render("one\n{{#wat x}}", {})).toThrow(/Unknown block "wat".*line 2, column 1/);
    expect(() => render("{{#if x}}{{else}}{{else}}{{/if}}", {})).toThrow(/Duplicate else.*column 18/);
    expect(() => render("{{else}}", {})).toThrow(/outside a block.*line 1, column 1/);
    expect(() => render("{{#if x}}\n{{/each}}", {})).toThrow(/expected \/if but found \/each.*line 2, column 1/);
    expect(() => render("x {{#each xs}}", {})).toThrow(/Unclosed each block.*line 1, column 3/);
  });
});
