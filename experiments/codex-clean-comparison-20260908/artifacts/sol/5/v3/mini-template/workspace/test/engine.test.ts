import { describe, expect, test } from "bun:test";
import { render } from "../src/engine";

describe("render", () => {
  test("interpolates escaped and raw scalar values", () => {
    const data = { value: `& < > " '`, count: 0, enabled: false };
    expect(render("{{value}}|{{{value}}}|{{count}}|{{enabled}}", data)).toBe(
      "&amp; &lt; &gt; &quot; &#39;|& < > \" '|0|false",
    );
  });

  test("renders missing values as empty strings and preserves whitespace", () => {
    expect(render(" a\n  {{missing}} z ", {})).toBe(" a\n   z ");
  });

  test("supports nested conditionals, else, comments, and specified truthiness", () => {
    const template = "{{! ignored }}{{#if outer}}A{{#if inner}}B{{else}}C{{/if}}{{else}}D{{/if}}";
    expect(render(template, { outer: true, inner: 0 })).toBe("AC");
    expect(render(template, { outer: [], inner: true })).toBe("D");
    expect(render("{{#if value}}yes{{else}}no{{/if}}", { value: {} })).toBe("yes");
  });

  test("iterates arrays with this, index, item properties, and root fallback", () => {
    const template = "{{#each users}}[{{@index}}:{{name}}/{{title}}]{{else}}empty{{/each}}";
    expect(render(template, { title: "root", users: [{ name: "Ada" }, { name: "Lin" }] })).toBe(
      "[0:Ada/root][1:Lin/root]",
    );
    expect(render(template, { title: "root", users: [] })).toBe("empty");
    expect(render("{{#each values}}{{this}};{{/each}}", { values: [1, "x", false] })).toBe("1;x;false;");
  });

  test("supports nested loops and outer-item path lookup", () => {
    const template = "{{#each groups}}{{name}}={{#each this.values}}{{name}}:{{this}}@{{@index}},{{/each}};{{/each}}";
    expect(render(template, { groups: [{ name: "g", values: ["a", "b"] }] })).toBe("g=g:a@0,g:b@1,;");
  });

  test("rejects non-scalar interpolation", () => {
    expect(() => render("line\n{{value}}", { value: { nested: true } })).toThrow(
      "Value at \"value\" is not scalar text at line 2, column 1",
    );
    expect(() => render("{{this}}", () => undefined)).toThrow();
  });

  test("reports structural errors with line and column", () => {
    expect(() => render("x\n{{else}}", {})).toThrow("Unexpected else outside a block at line 2, column 1");
    expect(() => render("{{#if ok}}{{else}}{{else}}{{/if}}", {})).toThrow("Duplicate else");
    expect(() => render("{{#if ok}}{{/each}}", {})).toThrow("Mismatched closing block");
    expect(() => render("{{#wat ok}}x{{/wat}}", {})).toThrow("Unknown block \"wat\"");
    expect(() => render("before {{#each xs}}", {})).toThrow("Unclosed each block at line 1, column 8");
    expect(() => render("{{name", {})).toThrow("Unclosed tag at line 1, column 1");
  });
});
