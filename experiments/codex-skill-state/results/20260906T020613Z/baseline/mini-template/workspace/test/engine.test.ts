import { describe, expect, test } from "bun:test";
import { render } from "../src/engine";

describe("render", () => {
  test("interpolates nested paths, escapes HTML, and preserves whitespace", () => {
    expect(render("  {{user.name}}\n{{{html}}} ", {
      user: { name: `<Tom & \"Sue\">'` },
      html: "<b>ok</b>",
    })).toBe("  &lt;Tom &amp; &quot;Sue&quot;&gt;&#39;\n<b>ok</b> ");
  });

  test("renders missing and null values as empty strings", () => {
    expect(render("{{missing}}/{{value}}", { value: null })).toBe("/");
  });

  test("supports nested conditionals and the specified truthiness", () => {
    const template = "{{#if value}}yes{{#if nested}}!{{else}}.{{/if}}{{else}}no{{/if}}";
    expect(render(template, { value: [1], nested: 1 })).toBe("yes!");
    for (const value of ["", 0, false, null, undefined, []]) {
      expect(render(template, { value })).toBe("no");
    }
    expect(render("{{#if value}}yes{{else}}no{{/if}}", { value: Number.NaN })).toBe("yes");
  });

  test("iterates nested arrays with context, indices, and root fallback", () => {
    const template = "{{#each groups}}[{{name}}:{{@index}}={{#each values}}{{this}}/{{@index}}/{{title}};{{else}}empty{{/each}}]{{else}}none{{/each}}";
    const data = {
      title: "root",
      groups: [
        { name: "a", values: [10, 20] },
        { name: "b", values: [] },
      ],
    };
    expect(render(template, data)).toBe("[a:0=10/0/root;20/1/root;][b:1=empty]");
    expect(render("{{#each items}}x{{else}}none{{/each}}", { items: "not an array" })).toBe("none");
  });

  test("comments emit nothing", () => {
    expect(render("a{{! ignored }}b", {})).toBe("ab");
  });

  test("rejects structural errors with line and column", () => {
    expect(() => render("x\n{{else}}", {})).toThrow("line 2, column 1");
    expect(() => render("{{#if x}}a{{else}}b{{else}}c{{/if}}", {})).toThrow("Duplicate else");
    expect(() => render("{{#if x}}{{/each}}", {})).toThrow("expected /if, received /each");
    expect(() => render("{{#wat x}}{{/wat}}", {})).toThrow('Unknown block "wat"');
    expect(() => render("before {{#if x}}", {})).toThrow("Unclosed if block");
    expect(() => render("{{/if}}", {})).toThrow("Unexpected closing block");
  });

  test("rejects non-scalar interpolation values", () => {
    expect(() => render("{{user}}", { user: { name: "Ada" } })).toThrow("cannot be rendered as scalar text");
    expect(() => render("{{items}}", { items: [] })).toThrow("cannot be rendered as scalar text");
    expect(() => render("{{fn}}", { fn: () => 1 })).toThrow("cannot be rendered as scalar text");
  });
});
