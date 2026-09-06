import { describe, expect, test } from "bun:test";
import { render } from "../src/engine";

describe("render", () => {
  test("escapes values, supports raw values, missing values, and comments", () => {
    expect(render("{{value}}|{{{value}}}|{{missing}}|{{! ignored }}done", {
      value: "<&>\"'",
    })).toBe("&lt;&amp;&gt;&quot;&#39;|<&>\"'||done");
  });

  test("preserves whitespace and evaluates if truthiness", () => {
    expect(render(" a\n{{#if items}}yes{{else}}no{{/if}}\n ", { items: [] }))
      .toBe(" a\nno\n ");
    expect(render("{{#if n}}bad{{else}}ok{{/if}}", { n: 0 })).toBe("ok");
    expect(render("{{#if object}}ok{{/if}}", { object: {} })).toBe("ok");
  });

  test("iterates, exposes locals, falls back to root, and nests loops", () => {
    const template = "{{#each groups}}[{{name}}/{{title}}:{{#each items}}{{@index}}={{this}};{{else}}empty{{/each}}]{{else}}none{{/each}}";
    expect(render(template, {
      title: "T",
      groups: [
        { name: "A", items: ["x", "y"] },
        { name: "B", items: [] },
      ],
    })).toBe("[A/T:0=x;1=y;][B/T:empty]");
  });

  test("each else handles missing and non-array values", () => {
    expect(render("{{#each value}}x{{else}}empty{{/each}}", {})).toBe("empty");
    expect(render("{{#each value}}x{{else}}empty{{/each}}", { value: "not-array" })).toBe("empty");
  });

  test("rejects non-scalar interpolation", () => {
    expect(() => render("line\n{{item}}", { item: {} })).toThrow(/cannot be rendered.*line 2, column 1/);
    expect(() => render("{{items}}", { items: [] })).toThrow(/cannot be rendered/);
  });

  test.each([
    ["{{#wat x}}{{/wat}}", /Unknown block.*line 1, column 1/],
    ["x\n{{else}}", /else outside.*line 2, column 1/],
    ["{{#if x}}{{else}}{{else}}{{/if}}", /Duplicate else/],
    ["{{#if x}}{{/each}}", /Mismatched closing block/],
    ["{{/if}}", /without an open block/],
    ["{{#if x}}", /Unclosed if block/],
    ["{{value", /Unclosed tag/],
  ])("reports structural error for %s", (template, pattern) => {
    expect(() => render(template, {})).toThrow(pattern);
  });
});
