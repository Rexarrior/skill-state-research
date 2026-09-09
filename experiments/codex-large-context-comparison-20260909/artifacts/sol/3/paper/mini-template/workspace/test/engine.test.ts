import { describe, expect, test } from "bun:test";
import { render } from "../src/engine";

describe("interpolation", () => {
  test("escapes HTML and supports raw values", () => {
    const data = { value: `&<>"'` };
    expect(render("{{value}}|{{{value}}}", data)).toBe("&amp;&lt;&gt;&quot;&#39;|&<>\"'");
  });

  test("resolves nested paths and renders missing values empty", () => {
    expect(render("{{user.name}}/{{missing}}", { user: { name: "Ada" } })).toBe("Ada/");
  });

  test("rejects non-scalar interpolation", () => {
    expect(() => render("{{user}}", { user: {} })).toThrow(/not scalar text.*line 1, column 1/);
    expect(() => render("{{fn}}", { fn() {} })).toThrow(/not scalar text/);
  });
});

describe("blocks", () => {
  test.each([
    ["", "F"], [0, "F"], [false, "F"], [null, "F"], [undefined, "F"], [[], "F"],
    ["x", "T"], [1, "T"], [{}, "T"], [[0], "T"],
  ])("implements specified truthiness for %p", (value, expected) => {
    expect(render("{{#if value}}T{{else}}F{{/if}}", { value })).toBe(expected);
  });

  test("supports nested conditionals", () => {
    expect(render("{{#if a}}A{{#if b}}B{{else}}C{{/if}}{{else}}D{{/if}}", { a: true, b: false })).toBe("AC");
  });

  test("iterates with locals and root fallback", () => {
    const template = "{{#each users}}[{{@index}}:{{name}}/{{site}}/{{this.name}}]{{else}}none{{/each}}";
    expect(render(template, { site: "HQ", users: [{ name: "A" }, { name: "B" }] })).toBe("[0:A/HQ/A][1:B/HQ/B]");
    expect(render(template, { site: "HQ", users: [] })).toBe("none");
  });

  test("supports nested loops", () => {
    const template = "{{#each groups}}{{name}}:{{#each members}}{{@index}}={{this}};{{else}}empty{{/each}}|{{/each}}";
    const data = { groups: [{ name: "a", members: ["x", "y"] }, { name: "b", members: [] }] };
    expect(render(template, data)).toBe("a:0=x;1=y;|b:empty|");
  });

  test("non-arrays use each else", () => {
    expect(render("{{#each value}}bad{{else}}empty{{/each}}", { value: "not an array" })).toBe("empty");
  });
});

test("comments disappear and surrounding whitespace is exact", () => {
  expect(render(" a \n{{! ignored }}\n b ", {})).toBe(" a \n\n b ");
});

describe("syntax errors", () => {
  test.each([
    ["{{#wat x}}{{/wat}}", /Unknown block.*line 1, column 1/],
    ["x\n{{else}}", /else outside.*line 2, column 1/],
    ["{{#if x}}{{else}}{{else}}{{/if}}", /Duplicate else.*column 18/],
    ["{{#if x}}{{/each}}", /Mismatched closing block.*column 10/],
    ["{{/if}}", /without an open block.*column 1/],
    ["{{#if x}}", /Unclosed if block.*column 1/],
    ["hello {{name", /Unclosed tag.*column 7/],
  ])("reports an actionable error for %s", (template, pattern) => {
    expect(() => render(template, { x: true })).toThrow(pattern);
  });
});
