import { describe, expect, test } from "bun:test";
import { render } from "../src/engine";

describe("render", () => {
  test("interpolates paths, escapes HTML, and preserves whitespace", () => {
    expect(render(" Hello {{user.name}}!\n{{missing}}", { user: { name: `<A & "B's">` } }))
      .toBe(" Hello &lt;A &amp; &quot;B&#39;s&quot;&gt;!\n");
    expect(render("{{{html}}}", { html: "<b>yes</b>" })).toBe("<b>yes</b>");
  });

  test("supports nested conditionals and specified truthiness", () => {
    expect(render("{{#if yes}}Y{{#if no}}bad{{else}}N{{/if}}{{else}}bad{{/if}}", { yes: [], no: true }))
      .toBe("bad");
    expect(render("{{#if yes}}Y{{#if no}}bad{{else}}N{{/if}}{{/if}}", { yes: [1], no: 0 }))
      .toBe("YN");
  });

  test("iterates nested arrays with this, index, root fallback, and else", () => {
    const template = "{{#each groups}}[{{@index}}:{{this.name}}/{{title}}:{{#each this.items}}{{@index}}={{this}};{{else}}empty{{/each}}]{{else}}none{{/each}}";
    expect(render(template, { title: "T", groups: [{ name: "a", items: ["x", "y"] }, { name: "b", items: [] }] }))
      .toBe("[0:a/T:0=x;1=y;][1:b/T:empty]");
    expect(render("{{#each rows}}x{{else}}none{{/each}}", { rows: "not-array" })).toBe("none");
  });

  test("removes comments", () => {
    expect(render("a{{! ignored }}b", {})).toBe("ab");
  });

  test("rejects non-scalar interpolation", () => {
    expect(() => render("{{value}}", { value: {} })).toThrow("not scalar text");
    expect(() => render("{{value}}", { value: () => 1 })).toThrow("not scalar text");
  });

  test.each([
    ["{{#wat x}}", "Unknown block", "line 1, column 1"],
    ["{{else}}", "outside a block", "line 1, column 1"],
    ["{{#if x}}\n{{else}}a{{else}}", "Duplicate", "line 2, column 10"],
    ["{{#if x}}{{/each}}", "Mismatched", "line 1, column 10"],
    ["x\n{{#each xs}}", "Unclosed", "line 2, column 1"],
    ["x {{name", "Unclosed", "line 1, column 3"],
  ])("reports useful structural errors for %s", (template, message, position) => {
    expect(() => render(template, {})).toThrow(message);
    expect(() => render(template, {})).toThrow(position);
  });
});
