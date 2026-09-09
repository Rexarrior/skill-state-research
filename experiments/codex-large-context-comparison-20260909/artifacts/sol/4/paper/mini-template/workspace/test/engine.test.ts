import { describe, expect, test } from "bun:test";
import { render } from "../src/engine";

describe("render", () => {
  test("interpolates, escapes, preserves whitespace, and ignores comments", () => {
    expect(render(" A {{name}} / {{{raw}}} {{! no }}\n", { name: `<&>\"'`, raw: "<b>x</b>" }))
      .toBe(" A &lt;&amp;&gt;&quot;&#39; / <b>x</b> \n");
  });

  test("renders missing values as empty strings", () => {
    expect(render("x{{missing.deep}}y", {})).toBe("xy");
  });

  test("supports nested conditionals and specified truthiness", () => {
    expect(render("{{#if a}}A{{#if b}}B{{else}}C{{/if}}{{else}}D{{/if}}", { a: [], b: true })).toBe("D");
    expect(render("{{#if a}}yes{{else}}no{{/if}}", { a: {} })).toBe("yes");
  });

  test("iterates nested arrays with index, this, local paths, and root fallback", () => {
    const template = "{{#each groups}}[{{name}}/{{title}}:{{#each items}}{{@index}}={{this}};{{else}}empty{{/each}}]{{else}}none{{/each}}";
    expect(render(template, { title: "T", groups: [{ name: "A", items: ["x", "y"] }, { name: "B", items: [] }] }))
      .toBe("[A/T:0=x;1=y;][B/T:empty]");
  });

  test("rejects non-scalar interpolation", () => {
    expect(() => render("first\n{{item}}", { item: {} })).toThrow("Cannot render an object as text at line 2, column 1");
  });

  test.each([
    ["{{#wat x}}{{/wat}}", "Unknown or malformed block wat at line 1, column 1"],
    ["{{#if x}}{{/each}}", "Mismatched closing block /each; expected /if"],
    ["{{#if x}}", "Unclosed block if at line 1, column 1"],
    ["{{else}}", "Unexpected else outside a block at line 1, column 1"],
    ["{{#if x}}{{else}}{{else}}{{/if}}", "Duplicate else"],
  ])("reports structural errors for %s", (template, message) => {
    expect(() => render(template, { x: true })).toThrow(message);
  });
});

