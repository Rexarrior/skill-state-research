import { describe, expect, test } from "bun:test";
import { render } from "./engine";

describe("render", () => {
  test("escapes interpolated scalars and preserves whitespace", () => {
    expect(render(" Hello, {{name}}!\n", { name: `<A & B> \"'` })).toBe(
      " Hello, &lt;A &amp; B&gt; &quot;&#39;!\n",
    );
    expect(render("{{missing}}/{{nil}}/{{zero}}/{{false}}", {
      nil: null,
      zero: 0,
      false: false,
    })).toBe("//0/false");
  });

  test("supports raw interpolation and comments", () => {
    expect(render("a{{! discard <this> }}b {{{html}}}", { html: "<b>x</b>" })).toBe(
      "ab <b>x</b>",
    );
  });

  test("handles if truthiness and nesting", () => {
    const template = "{{#if user}}Y{{#if enabled}}+{{else}}-{{/if}}{{else}}N{{/if}}";
    expect(render(template, { user: { name: "A" }, enabled: true })).toBe("Y+");
    expect(render(template, { user: {}, enabled: false })).toBe("Y-");
    for (const value of ["", 0, false, null, undefined, []]) {
      expect(render("{{#if x}}yes{{else}}no{{/if}}", { x: value })).toBe("no");
    }
    expect(render("{{#if x}}yes{{else}}no{{/if}}", { x: {} })).toBe("yes");
  });

  test("iterates arrays with local values, indexes, root fallback, and nesting", () => {
    const template = "{{#each groups}}[{{name}}/{{title}}:{{#each this.items}}{{@index}}={{this}};{{else}}empty{{/each}}]{{else}}none{{/each}}";
    expect(render(template, {
      title: "root",
      groups: [
        { name: "a", items: ["x", "y"] },
        { name: "b", items: [] },
      ],
    })).toBe("[a/root:0=x;1=y;][b/root:empty]");
    expect(render("{{#each values}}{{this}}{{else}}empty{{/each}}", { values: [] })).toBe("empty");
    expect(render("{{#each values}}bad{{else}}empty{{/each}}", { values: "not-array" })).toBe("empty");
  });

  test("rejects non-scalar interpolation", () => {
    expect(() => render("{{value}}", { value: {} })).toThrow(/cannot be rendered as scalar text.*line 1, column 1/);
    expect(() => render("{{value}}", { value: [1] })).toThrow(/cannot be rendered as scalar text/);
  });

  test("reports useful structural syntax errors", () => {
    expect(() => render("x\n{{else}}", {})).toThrow(/else outside a block at line 2, column 1/);
    expect(() => render("{{#if x}}{{else}}{{else}}{{/if}}", {})).toThrow(/Duplicate else/);
    expect(() => render("{{#if x}}{{/each}}", {})).toThrow(/Mismatched closing block \/each; expected \/if/);
    expect(() => render("{{#wat x}}{{/wat}}", {})).toThrow(/Unknown block/);
    expect(() => render("{{#each x}}", {})).toThrow(/Unclosed block #each at line 1, column 1/);
    expect(() => render("{{/if}}", {})).toThrow(/Unexpected closing block \/if/);
    expect(() => render("{{name", {})).toThrow(/Unclosed tag/);
  });
});
