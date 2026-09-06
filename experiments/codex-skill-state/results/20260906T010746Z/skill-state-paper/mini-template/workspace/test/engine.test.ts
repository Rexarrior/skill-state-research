import { describe, expect, test } from "bun:test";
import { render } from "../src/engine";

describe("interpolation", () => {
  test("escapes HTML and supports raw values", () => {
    const data = { value: `&<>"'` };
    expect(render("{{value}}|{{{value}}}", data)).toBe("&amp;&lt;&gt;&quot;&#39;|&<>\"'");
  });

  test("resolves dotted paths and renders missing values empty", () => {
    expect(render("Hi {{user.name}} {{missing}}!", { user: { name: "Ada" } })).toBe("Hi Ada !");
  });

  test("rejects non-scalar interpolation", () => {
    expect(() => render("line one\n{{user}}", { user: {} })).toThrow(/line 2, column 1/);
  });
});

describe("blocks", () => {
  test("supports nested if blocks and specified truthiness", () => {
    expect(render("{{#if a}}A{{#if b}}B{{else}}C{{/if}}{{else}}D{{/if}}", { a: true, b: 0 })).toBe("AC");
    for (const value of ["", 0, false, null, undefined, []]) {
      expect(render("{{#if value}}yes{{else}}no{{/if}}", { value })).toBe("no");
    }
    expect(render("{{#if value}}yes{{else}}no{{/if}}", { value: {} })).toBe("yes");
  });

  test("iterates arrays with locals, root fallback, nesting, and else", () => {
    const template = "{{#each groups}}[{{name}}/{{title}}:{{#each items}}{{@index}}={{this}};{{else}}empty{{/each}}]{{else}}none{{/each}}";
    const data = { title: "root", groups: [{ name: "A", items: ["x", "y"] }, { name: "B", items: [] }] };
    expect(render(template, data)).toBe("[A/root:0=x;1=y;][B/root:empty]");
    expect(render("{{#each xs}}x{{else}}empty{{/each}}", { xs: "not-array" })).toBe("empty");
  });

  test("comments emit nothing and whitespace remains exact", () => {
    expect(render(" a \n{{! ignored }}\n b ", {})).toBe(" a \n\n b ");
  });
});

describe("syntax errors", () => {
  test("reports structural mistakes with locations", () => {
    expect(() => render("x\n{{#wat value}}", {})).toThrow(/Unknown.*line 2, column 1/);
    expect(() => render("{{#if ok}}{{else}}{{else}}{{/if}}", {})).toThrow(/Duplicate.*line 1, column 19/);
    expect(() => render("{{else}}", {})).toThrow(/outside.*line 1, column 1/);
    expect(() => render("{{#if ok}}{{/each}}", {})).toThrow(/Mismatched.*line 1, column 11/);
    expect(() => render("{{#if ok}}", {})).toThrow(/Unclosed.*line 1, column 1/);
    expect(() => render("before {{name", {})).toThrow(/Unclosed tag.*column 8/);
  });
});
