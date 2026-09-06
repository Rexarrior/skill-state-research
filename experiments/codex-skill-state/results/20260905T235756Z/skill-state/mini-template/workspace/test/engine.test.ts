import { describe, expect, test } from "bun:test";
import { render } from "../src/engine";

describe("render", () => {
  test("escapes interpolations and preserves raw interpolations", () => {
    const value = `&<>"'`;
    expect(render("{{value}}|{{{value}}}", { value })).toBe("&amp;&lt;&gt;&quot;&#39;|&<>\"'");
  });

  test("resolves nested values and renders missing values empty", () => {
    expect(render("Hello {{user.name}}/{{missing}}!", { user: { name: "Ada" } })).toBe("Hello Ada/!");
  });

  test("supports nested conditions and defined false values", () => {
    const template = "{{#if user}}{{#if user.active}}yes{{else}}no{{/if}}{{else}}none{{/if}}";
    expect(render(template, { user: { active: false } })).toBe("no");
    expect(render(template, { user: null })).toBe("none");
    expect(render("{{#if items}}yes{{else}}no{{/if}}", { items: [] })).toBe("no");
  });

  test("iterates arrays with current values, indexes, and root fallback", () => {
    const template = "{{#each users}}[{{@index}}:{{name}}/{{site}}]{{else}}empty{{/each}}";
    expect(render(template, { site: "HQ", users: [{ name: "A" }, { name: "B" }] })).toBe("[0:A/HQ][1:B/HQ]");
    expect(render(template, { site: "HQ", users: [] })).toBe("empty");
  });

  test("supports nested loops", () => {
    const template = "{{#each rows}}{{#each this}}{{@index}}={{this}};{{/each}}|{{/each}}";
    expect(render(template, { rows: [["a", "b"], ["c"]] })).toBe("0=a;1=b;|0=c;|");
  });

  test("removes comments while preserving surrounding whitespace", () => {
    expect(render(" a {{! ignore me }} \n b ", {})).toBe(" a  \n b ");
  });

  test("rejects non-scalar interpolation", () => {
    expect(() => render("x {{user}}", { user: { name: "Ada" } })).toThrow(/not a renderable scalar.*line 1, column 3/);
  });

  test.each([
    ["{{#wat x}}{{/wat}}", /Unknown block 'wat'.*line 1, column 1/],
    ["x\n{{#if x}}{{/each}}", /Mismatched closing block 'each'.*line 2, column 10/],
    ["{{#if x}}", /Unclosed 'if' block.*line 1, column 1/],
    ["{{else}}", /'else' outside a block.*line 1, column 1/],
    ["{{#if x}}{{else}}{{else}}{{/if}}", /Duplicate 'else'.*line 1, column 18/],
  ])("reports structural errors for %s", (template, expected) => {
    expect(() => render(template, { x: true })).toThrow(expected);
  });
});
