import { describe, expect, test } from "bun:test";
import { render, TemplateError } from "../src/engine";

describe("render", () => {
  test("escapes interpolation and leaves triple interpolation raw", () => {
    const data = { value: `&<>"'` };
    expect(render("{{value}}|{{{value}}}", data)).toBe("&amp;&lt;&gt;&quot;&#39;|&<>\"'");
  });

  test("supports nested paths and missing values", () => {
    expect(render("Hello {{person.name}}/{{missing}}!", { person: { name: "Ada" } }))
      .toBe("Hello Ada/!");
  });

  test("implements the specified if truthiness", () => {
    for (const value of ["", 0, 0n, false, null, undefined, []]) {
      expect(render("{{#if value}}yes{{else}}no{{/if}}", { value })).toBe("no");
    }
    for (const value of ["0", 1, Number.NaN, true, {}, [0]]) {
      expect(render("{{#if value}}yes{{else}}no{{/if}}", { value })).toBe("yes");
    }
  });

  test("iterates nested loops with indices and root fallback", () => {
    const template = "{{#each groups}}[{{name}}:{{#each this.items}}{{@index}}={{this}}/{{title}};{{else}}empty{{/each}}]{{/each}}";
    const data = {
      title: "root",
      groups: [
        { name: "a", items: ["x", "y"] },
        { name: "b", items: [] },
      ],
    };
    expect(render(template, data)).toBe("[a:0=x/root;1=y/root;][b:empty]");
  });

  test("preserves whitespace and removes comments", () => {
    expect(render(" a \n{{! ignored }}\n b ", {})).toBe(" a \n\n b ");
  });

  test("rejects non-scalar interpolation", () => {
    expect(() => render("line\n{{value}}", { value: {} })).toThrow(
      "Value at 'value' is not a renderable scalar at line 2, column 1",
    );
  });

  test.each([
    ["{{#wat x}}{{/wat}}", "Unknown or invalid block 'wat' at line 1, column 1"],
    ["{{/if}}", "Closing 'if' without an open block at line 1, column 1"],
    ["{{#if x}}{{/each}}", "Mismatched closing block 'each'; expected 'if' at line 1, column 10"],
    ["{{#if x}}{{else}}{{else}}{{/if}}", "Duplicate 'else' at line 1, column 18"],
    ["x\n{{else}}", "'else' outside a block at line 2, column 1"],
    ["{{#if x}}", "Unclosed 'if' block at line 1, column 1"],
  ])("reports structural error coordinates for %s", (template, message) => {
    expect(() => render(template, {})).toThrow(message);
  });

  test("exports a recognizable template error", () => {
    expect(() => render("{{#nope x}}", {})).toThrow(TemplateError);
  });
});
