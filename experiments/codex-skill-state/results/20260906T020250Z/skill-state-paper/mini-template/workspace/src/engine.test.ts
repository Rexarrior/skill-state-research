import { describe, expect, test } from "bun:test";
import { render } from "./engine";

describe("render", () => {
  test("interpolates escaped, raw, missing, and comment values", () => {
    const data = { value: `<a href='x'>&"`, raw: "<b>ok</b>" };
    expect(render("{{value}}|{{{raw}}}|{{missing}}{{! ignored }}", data)).toBe(
      "&lt;a href=&#39;x&#39;&gt;&amp;&quot;|<b>ok</b>|",
    );
  });

  test("preserves whitespace and follows the specified truthiness", () => {
    const template = " A\n{{#if value}}yes{{else}}no{{/if}}\nZ ";
    for (const value of ["", 0, false, null, undefined, []]) {
      expect(render(template, { value })).toBe(" A\nno\nZ ");
    }
    for (const value of ["x", 1, true, {}, [0]]) {
      expect(render(template, { value })).toBe(" A\nyes\nZ ");
    }
  });

  test("supports nested each, indexes, this paths, root fallback, and else", () => {
    const template =
      "{{#each groups}}[{{@index}}:{{this.name}}/{{title}}:" +
      "{{#each items}}{{@index}}={{this}};{{else}}empty{{/each}}]" +
      "{{else}}none{{/each}}";
    expect(render(template, {
      title: "T",
      groups: [
        { name: "a", items: ["x", "y"] },
        { name: "b", items: [] },
      ],
    })).toBe("[0:a/T:0=x;1=y;][1:b/T:empty]");
    expect(render(template, { title: "T", groups: [] })).toBe("none");
  });

  test("if and each blocks can be nested", () => {
    expect(render(
      "{{#each rows}}{{#if active}}{{name}}{{else}}-{{/if}}{{/each}}",
      { rows: [{ name: "A", active: true }, { name: "B", active: false }] },
    )).toBe("A-");
  });

  test("rejects structural mistakes with positions", () => {
    expect(() => render("x\n{{#wat x}}", {})).toThrow("Unknown block 'wat' at line 2, column 1");
    expect(() => render("{{else}}", {})).toThrow("else outside a block at line 1, column 1");
    expect(() => render("{{#if x}}{{else}}{{else}}{{/if}}", {})).toThrow("Duplicate else");
    expect(() => render("{{#if x}}{{/each}}", {})).toThrow("Mismatched closing block");
    expect(() => render("{{#each x}}", {})).toThrow("Unclosed block '#each'");
    expect(() => render("{{/nope}}", {})).toThrow("without an open block");
    expect(() => render("hello {{name", {})).toThrow("Unclosed tag");
  });

  test("rejects non-scalar interpolation", () => {
    expect(() => render("value={{value}}", { value: { nested: true } })).toThrow(
      "Value 'value' is not renderable as scalar text",
    );
    expect(() => render("{{value}}", { value: [1, 2] })).toThrow("not renderable");
  });
});
