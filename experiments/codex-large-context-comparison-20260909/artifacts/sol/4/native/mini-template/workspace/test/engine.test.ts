import { describe, expect, test } from "bun:test";
import { render } from "../src/engine.ts";

describe("render", () => {
  test("interpolates escaped, raw, missing, and scalar values", () => {
    const data = { html: `<a title="x">Tom & Jerry's</a>`, count: 0, ok: false };
    expect(render("{{html}}", data)).toBe(
      "&lt;a title=&quot;x&quot;&gt;Tom &amp; Jerry&#39;s&lt;/a&gt;",
    );
    expect(render("{{{html}}} {{count}} {{ok}} [{{missing}}]", data)).toBe(
      `<a title="x">Tom & Jerry's</a> 0 false []`,
    );
  });

  test("preserves whitespace and removes comments", () => {
    expect(render("  a\n{{! ignored }}\n b  ", {})).toBe("  a\n\n b  ");
  });

  test("handles truthiness and nested conditionals", () => {
    const template = "{{#if yes}}A{{#if empty}}X{{else}}B{{/if}}{{else}}C{{/if}}";
    expect(render(template, { yes: [], empty: true })).toBe("C");
    expect(render(template, { yes: {}, empty: "" })).toBe("AB");
    expect(render("{{#if nan}}yes{{else}}no{{/if}}", { nan: NaN })).toBe("yes");
    expect(render("{{#if zero}}yes{{else}}no{{/if}}", { zero: 0n })).toBe("no");
  });

  test("iterates arrays with local values, indexes, root fallback, and nesting", () => {
    const template = [
      "{{#each groups}}",
      "{{name}}={{#each items}}({{@index}}:{{this}}/{{title}}){{else}}empty{{/each}};",
      "{{else}}none{{/each}}",
    ].join("");
    const data = {
      title: "ROOT",
      groups: [
        { name: "a", items: ["x", "y"] },
        { name: "b", items: [] },
      ],
    };
    expect(render(template, data)).toBe("a=(0:x/ROOT)(1:y/ROOT);b=empty;");
    expect(render("{{#each absent}}x{{else}}none{{/each}}", data)).toBe("none");
  });

  test("rejects nonscalar interpolation values", () => {
    expect(() => render("x {{user}}", { user: { name: "A" } })).toThrow(
      'Value at "user" cannot be rendered as scalar text at line 1, column 3',
    );
    expect(() => render("{{fn}}", { fn() {} })).toThrow("cannot be rendered");
  });

  test.each([
    ["{{#wat x}}{{/wat}}", 'Unknown block "wat" at line 1, column 1'],
    ["x\n{{else}}", "Unexpected else outside a block at line 2, column 1"],
    ["{{#if x}}{{else}}{{else}}{{/if}}", "Duplicate else"],
    ["{{#if x}}{{/each}}", "Mismatched closing block"],
    ["{{/if}}", "Unexpected closing block"],
    ["a {{#each x}}", "Unclosed each block at line 1, column 3"],
    ["a {{name", "Unclosed tag at line 1, column 3"],
  ])("reports structural error for %s", (template, message) => {
    expect(() => render(template, {})).toThrow(message);
  });
});
