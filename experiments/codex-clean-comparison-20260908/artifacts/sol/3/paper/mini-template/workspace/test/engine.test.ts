import { describe, expect, test } from "bun:test";
import { render } from "../src/engine";

describe("render", () => {
  test("interpolates escaped, raw, nested, and missing values", () => {
    const data = { user: { name: `<Tom & "Sue" 'Jr'>` } };
    expect(render("Hi {{user.name}} / {{{user.name}}} / {{missing}}", data)).toBe(
      `Hi &lt;Tom &amp; &quot;Sue&quot; &#39;Jr&#39;&gt; / <Tom & "Sue" 'Jr'> / `,
    );
  });

  test("handles nested conditionals and specified truthiness", () => {
    expect(render("{{#if a}}A{{#if b}}B{{else}}C{{/if}}{{else}}D{{/if}}", { a: true, b: 0 })).toBe("AC");
    for (const value of ["", 0, false, null, undefined, []]) {
      expect(render("{{#if value}}yes{{else}}no{{/if}}", { value })).toBe("no");
    }
    expect(render("{{#if value}}yes{{else}}no{{/if}}", { value: {} })).toBe("yes");
  });

  test("iterates arrays with local lookup, root fallback, index, and nesting", () => {
    const template = "{{#each groups}}[{{name}}/{{title}}:{{#each items}}{{@index}}={{this}};{{else}}empty{{/each}}]{{else}}none{{/each}}";
    expect(render(template, {
      title: "root",
      groups: [{ name: "A", items: ["x", "y"] }, { name: "B", items: [] }],
    })).toBe("[A/root:0=x;1=y;][B/root:empty]");
    expect(render("{{#each values}}x{{else}}empty{{/each}}", { values: "not-array" })).toBe("empty");
  });

  test("preserves whitespace and removes comments", () => {
    expect(render(" a\n {{! ignored }} \t b ", {})).toBe(" a\n  \t b ");
  });

  test("rejects nonscalar interpolation", () => {
    expect(() => render("{{value}}", { value: {} })).toThrow("Cannot render object as scalar text at line 1, column 1");
    expect(() => render("{{value}}", { value: [] })).toThrow("Cannot render an array as scalar text");
  });

  test("reports structural errors with line and column", () => {
    expect(() => render("x\n{{else}}", {})).toThrow("'else' outside a block at line 2, column 1");
    expect(() => render("{{#if x}}{{else}}{{else}}{{/if}}", {})).toThrow("Duplicate 'else'");
    expect(() => render("{{#if x}}{{/each}}", {})).toThrow("Mismatched closing block 'each'; expected 'if'");
    expect(() => render("{{#wat x}}{{/wat}}", {})).toThrow("Unknown or malformed block");
    expect(() => render("{{#each x}}", {})).toThrow("Unclosed 'each' block at line 1, column 1");
  });
});
