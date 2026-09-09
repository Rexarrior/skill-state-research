import { describe, expect, test } from "bun:test";
import { render } from "../src/engine";

describe("render", () => {
  test("interpolates escaped, raw, nested, and missing values", () => {
    const data = { user: { name: `<Tom & "Sue's">`, html: "<b>ok</b>" } };
    expect(render("{{user.name}}|{{{user.html}}}|{{missing}}", data)).toBe(
      "&lt;Tom &amp; &quot;Sue&#39;s&quot;&gt;|<b>ok</b>|",
    );
  });

  test("preserves whitespace and removes comments", () => {
    expect(render(" a \n{{! ignored }}\n b ", {})).toBe(" a \n\n b ");
  });

  test("handles if truthiness, else, and nesting", () => {
    const source = "{{#if user}}Y{{#if tags}}+{{else}}-{{/if}}{{else}}N{{/if}}";
    expect(render(source, { user: true, tags: [] })).toBe("Y-");
    expect(render(source, { user: false, tags: [1] })).toBe("N");
    for (const value of ["", 0, false, null, undefined, []]) {
      expect(render("{{#if value}}yes{{else}}no{{/if}}", { value })).toBe("no");
    }
    expect(render("{{#if value}}yes{{/if}}", { value: {} })).toBe("yes");
  });

  test("iterates arrays with locals, root fallback, else, and nested loops", () => {
    const source = "{{#each groups}}[{{@index}}:{{name}}/{{title}}={{#each items}}({{@index}},{{this}},{{title}}){{else}}empty{{/each}}]{{else}}none{{/each}}";
    expect(render(source, {
      title: "ROOT",
      groups: [{ name: "A", items: ["x", "y"] }, { name: "B", items: [] }],
    })).toBe("[0:A/ROOT=(0,x,ROOT)(1,y,ROOT)][1:B/ROOT=empty]");
    expect(render("{{#each values}}{{this}}{{else}}none{{/each}}", { values: [] })).toBe("none");
  });

  test("rejects non-scalar interpolation", () => {
    expect(() => render("{{user}}", { user: { name: "Ada" } })).toThrow("Cannot render 'user' as scalar text (received object)");
    expect(() => render("{{items}}", { items: [] })).toThrow("received array");
  });

  test("reports structural errors with line and column", () => {
    expect(() => render("first\n{{else}}", {})).toThrow("'else' outside a block at line 2, column 1");
    expect(() => render("{{#if x}}{{else}}{{else}}{{/if}}", {})).toThrow("Duplicate 'else'");
    expect(() => render("{{#if x}}{{/each}}", {})).toThrow("expected '/if', got '/each'");
    expect(() => render("x {{#wat x}}", {})).toThrow("Unknown or malformed block 'wat' at line 1, column 3");
    expect(() => render("\n{{#each x}}", {})).toThrow("Unclosed 'each' block at line 2, column 1");
    expect(() => render("{{value", {})).toThrow("Unclosed tag at line 1, column 1");
  });
});
