import { describe, expect, test } from "bun:test";
import { render } from "../src/engine.ts";

describe("render", () => {
  test("interpolates, escapes HTML, and preserves whitespace", () => {
    expect(render(" Hello {{user.name}}!\n{{{html}}} ", {
      user: { name: `A&B <\"C\">'` },
      html: "<b>ok</b>",
    })).toBe(" Hello A&amp;B &lt;&quot;C&quot;&gt;&#39;!\n<b>ok</b> ");
  });

  test("renders missing values as empty strings and comments as nothing", () => {
    expect(render("a{{missing.value}}b{{! hidden }}c", {})).toBe("abc");
  });

  test("supports nested conditionals and specified truthiness", () => {
    const template = "{{#if outer}}A{{#if inner}}B{{else}}C{{/if}}{{else}}D{{/if}}";
    expect(render(template, { outer: true, inner: 0 })).toBe("AC");
    expect(render(template, { outer: [], inner: true })).toBe("D");
    expect(render("{{#if value}}T{{else}}F{{/if}}", { value: {} })).toBe("T");
  });

  test("iterates arrays with item, index, root fallback, nesting, and else", () => {
    const template = "{{#each groups}}[{{name}}/{{title}}:{{#each members}}{{@index}}={{this}};{{else}}none{{/each}}]{{else}}empty{{/each}}";
    expect(render(template, {
      title: "root",
      groups: [
        { name: "one", members: ["a", "b"] },
        { name: "two", members: [] },
      ],
    })).toBe("[one/root:0=a;1=b;][two/root:none]");
    expect(render("{{#each items}}x{{else}}empty{{/each}}", { items: null })).toBe("empty");
  });

  test("rejects non-scalar interpolation", () => {
    expect(() => render("before {{thing}}", { thing: {} })).toThrow("not scalar");
    expect(() => render("{{thing}}", { thing: [] })).toThrow("line 1, column 1");
  });

  test.each([
    ["{{else}}", "outside", "line 1, column 1"],
    ["{{#if x}}{{else}}{{else}}{{/if}}", "Duplicate", "line 1, column 18"],
    ["{{#if x}}{{/each}}", "Mismatched", "line 1, column 10"],
    ["x\n{{#each xs}}", "Unclosed", "line 2, column 1"],
    ["{{#wat x}}{{/wat}}", "Unknown", "line 1, column 1"],
    ["{{/if}}", "Unexpected", "line 1, column 1"],
  ])("reports structural error for %s", (template, message, position) => {
    expect(() => render(template, {})).toThrow(message);
    expect(() => render(template, {})).toThrow(position);
  });
});
