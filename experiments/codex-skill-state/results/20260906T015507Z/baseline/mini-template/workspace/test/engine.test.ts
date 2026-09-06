import { describe, expect, test } from "bun:test";
import { render } from "../src/engine";

describe("interpolation", () => {
  test("escapes HTML and preserves surrounding whitespace", () => {
    expect(render("  {{user.name}}\n", { user: { name: `<&>\"'` } })).toBe(
      "  &lt;&amp;&gt;&quot;&#39;\n",
    );
  });

  test("supports unescaped and missing values", () => {
    expect(render("{{{html}}}|{{missing}}", { html: "<b>x</b>" })).toBe("<b>x</b>|");
  });

  test("rejects non-scalar interpolation", () => {
    expect(() => render("before {{user}}", { user: { name: "Ada" } })).toThrow(
      /not scalar text.*line 1, column 8/,
    );
  });
});

describe("blocks", () => {
  test("uses the specified truthiness rules and nested if blocks", () => {
    expect(render("{{#if a}}A{{#if b}}B{{else}}C{{/if}}{{else}}D{{/if}}", { a: [], b: 1 })).toBe("D");
    expect(render("{{#if a}}A{{#if b}}B{{else}}C{{/if}}{{else}}D{{/if}}", { a: {}, b: 0 })).toBe("AC");
  });

  test("treats exactly the documented values as false", () => {
    const template = "{{#each values}}{{#if this}}T{{else}}F{{/if}}{{/each}}";
    expect(render(template, { values: ["", 0, false, null, undefined, [], {}, "0", NaN] })).toBe(
      "FFFFFFTTT",
    );
  });

  test("iterates arrays with item fields, this, index, root fallback, and nesting", () => {
    const template = "{{#each groups}}[{{title}}/{{site}}:{{#each members}}{{@index}}={{this}};{{else}}none{{/each}}]{{else}}empty{{/each}}";
    const data = {
      site: "HQ",
      groups: [
        { title: "A", members: ["x", "y"] },
        { title: "B", members: [] },
      ],
    };
    expect(render(template, data)).toBe("[A/HQ:0=x;1=y;][B/HQ:none]");
  });

  test("uses each else for missing and non-array values", () => {
    expect(render("{{#each list}}x{{else}}empty{{/each}}", { list: "not an array" })).toBe("empty");
  });

  test("does not replace nullish current items with the root object", () => {
    expect(render("{{#each list}}({{this}}){{/each}}", { list: [null, undefined, "x"] })).toBe(
      "()()(x)",
    );
  });
});

describe("syntax diagnostics", () => {
  test.each([
    ["{{#wat x}}{{/wat}}", /Unknown block.*line 1, column 1/],
    ["{{else}}", /outside a block.*line 1, column 1/],
    ["{{#if x}}\n{{else}}a{{else}}b{{/if}}", /Duplicate.*line 2, column 10/],
    ["{{#if x}}{{/each}}", /Mismatched.*line 1, column 10/],
    ["x\n{{#each xs}}", /Unclosed.*line 2, column 1/],
    ["x {{value", /Unclosed tag.*line 1, column 3/],
  ])("reports an actionable error for %s", (template, message) => {
    expect(() => render(template, {})).toThrow(message);
  });

  test("comments emit nothing", () => {
    expect(render("a{{! discarded }}b", {})).toBe("ab");
  });
});
