import { describe, expect, test } from "bun:test";
import { render } from "./engine";

describe("interpolation", () => {
  test("escapes all HTML characters and preserves surrounding whitespace", () => {
    expect(render(" \n\t{{ user.text }}\r\n{{{user.text}}} ", { user: { text: `&<>"'` } }))
      .toBe(" \n\t&amp;&lt;&gt;&quot;&#39;\r\n&<>\"' ");
  });
  test("missing, null, scalar values, and numeric paths", () => {
    expect(render("{{missing}}/{{a.b}}/{{nil}}/{{no}}/{{zero}}/{{big}}/{{list.0}}", {
      a: null, nil: null, no: false, zero: 0, big: 12n, list: ["ok"],
    })).toBe("///false/0/12/ok");
    expect(render("{{this}}/{{@index}}", "root")).toBe("root/");
  });
  test("does not read inherited properties", () => {
    expect(render("{{secret}}/{{constructor}}/{{toString}}", Object.create({ secret: "hidden" }))).toBe("//");
  });
  test("rejects unsupported values even for raw output", () => {
    for (const value of [{}, [], () => 1, Symbol("x")]) {
      for (const tag of ["{{value}}", "{{{value}}}"]) {
        expect(() => render(`\n  ${tag}`, { value })).toThrow(/non-scalar.*value.*line 2, column 3/);
      }
    }
  });
  test("comments and empty templates", () => {
    expect(render("a {{! ignored\n comment }} b", {})).toBe("a  b");
    expect(render("", null)).toBe("");
    expect(render("untouched\n\t ", undefined)).toBe("untouched\n\t ");
  });
});

describe("blocks", () => {
  test("specified truthiness", () => {
    for (const value of ["", 0, false, null, undefined, []]) {
      expect(render("{{#if value}}yes{{else}}no{{/if}}", { value })).toBe("no");
    }
    for (const value of ["0", 1, true, {}, [false]]) {
      expect(render("{{#if value}}yes{{else}}no{{/if}}", { value })).toBe("yes");
    }
    expect(render("{{#if absent}}yes{{/if}}", {})).toBe("");
  });
  test("nested conditionals and skipped unsupported values", () => {
    const template = "{{#if a}}A{{#if b}}B{{else}}C{{/if}}{{else}}{{object}}{{/if}}";
    expect(render(template, { a: true, b: false, object: {} })).toBe("AC");
  });
  test("array iteration and else for empty or non-array input", () => {
    const template = "{{#each items}}{{@index}}={{this}};{{else}}empty{{/each}}";
    expect(render(template, { items: ["a", "b", null, 0] })).toBe("0=a;1=b;2=;3=0;");
    for (const items of [[], null, undefined, {}, "abc", 1]) {
      expect(render(template, { items })).toBe("empty");
    }
  });
  test("nested loops, root fallback, explicit this, and context restoration", () => {
    const template = "{{#each groups}}{{name}}:{{@index}}[{{#each this.items}}{{@index}}={{this}}/{{title}};{{/each}}]{{@index}}/{{name}}|{{/each}}";
    expect(render(template, {
      title: "ROOT", groups: [{ name: "A", items: ["x", "y"] }, { name: "B", items: ["z"] }],
    })).toBe("A:0[0=x/ROOT;1=y/ROOT;]0/A|B:1[0=z/ROOT;]1/B|");
  });
  test("item precedence and else retaining enclosing context", () => {
    expect(render("{{#each items}}{{name}}/{{this.name}}/{{rootOnly}};{{#each empty}}{{this}}{{else}}{{@index}}{{/each}}{{/each}}", {
      name: "ROOT", rootOnly: "R", empty: [], items: [{ name: "local" }, { name: null }, {}],
    })).toBe("local/local/R;0//R;1ROOT//R;2");
  });
});

describe("syntax errors", () => {
  test("reports useful locations", () => {
    for (const [source, message] of [
      ["\n  {{#wat x}}", /Unknown block.*line 2, column 3/],
      ["{{#if x}}\n{{/each}}", /Mismatched.*line 2, column 1/],
      ["\n{{/if}}", /Unexpected closing.*line 2, column 1/],
      ["\n {{#each x}}", /Unclosed each.*line 2, column 2/],
      ["{{#if x}}{{else}}\n{{else}}{{/if}}", /Duplicate else.*line 2, column 1/],
      [" {{else}}", /else outside.*line 1, column 2/],
      ["a\n{{x", /Unclosed tag.*line 2, column 1/],
      ["{{{x}}", /Unclosed tag/],
      ["{{#if}}", /Invalid path/],
      ["{{}}", /Invalid path/],
      ["{{a + b}}", /Invalid path/],
      ["{{#if no}}{{#unknown x}}{{/unknown}}{{/if}}", /Unknown block/],
    ] as const) {
      expect(() => render(source, {})).toThrow(message);
    }
  });
});
