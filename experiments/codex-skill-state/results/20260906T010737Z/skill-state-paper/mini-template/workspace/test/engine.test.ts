import { describe, expect, test } from "bun:test";
import { render } from "../src/engine";

describe("render", () => {
  test("escapes interpolation and leaves triple interpolation raw", () => {
    const value = `&<>"'`;
    expect(render("{{value}}|{{{value}}}", { value })).toBe(
      "&amp;&lt;&gt;&quot;&#39;|&<>\"'",
    );
  });

  test("preserves whitespace, removes comments, and empties missing values", () => {
    expect(render(" a\n{{! ignored }} {{missing}}\tb ", {})).toBe(" a\n \tb ");
  });

  test("implements the specified truthiness and nested if blocks", () => {
    for (const value of ["", 0, false, null, undefined, []]) {
      expect(render("{{#if value}}yes{{else}}no{{/if}}", { value })).toBe("no");
    }
    for (const value of ["0", 1, true, {}, [0]]) {
      expect(render("{{#if value}}A{{#if other}}B{{else}}C{{/if}}{{/if}}", {
        value,
        other: true,
      })).toBe("AB");
    }
  });

  test("iterates arrays with this, index, properties, and root fallback", () => {
    expect(render(
      "{{#each users}}[{{@index}}:{{name}}/{{site}}/{{this.name}}]{{else}}empty{{/each}}",
      { site: "HQ", users: [{ name: "Ada" }, { name: "Lin" }] },
    )).toBe("[0:Ada/HQ/Ada][1:Lin/HQ/Lin]");
    expect(render("{{#each users}}x{{else}}empty{{/each}}", { users: [] })).toBe("empty");
    expect(render("{{#each users}}x{{else}}empty{{/each}}", { users: "no" })).toBe("empty");
  });

  test("supports nested loops", () => {
    expect(render(
      "{{#each rows}}{{name}}:{{#each cells}}{{@index}}={{this}}/{{title}};{{/each}}|{{/each}}",
      { title: "T", rows: [{ name: "r1", cells: ["a", "b"] }, { name: "r2", cells: ["c"] }] },
    )).toBe("r1:0=a/T;1=b/T;|r2:0=c/T;|");
  });

  test("rejects non-scalar interpolations", () => {
    expect(() => render("before {{value}}", { value: { nested: true } })).toThrow(
      /Cannot render non-scalar value.*line 1, column 8/,
    );
  });

  test("reports structural mistakes with positions", () => {
    const cases: Array<[string, RegExp]> = [
      ["x\n{{#wat value}}", /Unknown or malformed block 'wat'.*line 2, column 1/],
      ["{{#if x}}{{/each}}", /Mismatched closing block 'each'.*line 1, column 10/],
      ["{{/if}}", /Unexpected closing block 'if'.*line 1, column 1/],
      ["{{#if x}}", /Unclosed 'if' block.*line 1, column 1/],
      ["x {{else}}", /Unexpected else outside a block.*line 1, column 3/],
      ["{{#if x}}{{else}}{{else}}{{/if}}", /Duplicate else.*line 1, column 18/],
      ["{{ value", /Unclosed template tag.*line 1, column 1/],
    ];
    for (const [template, expected] of cases) {
      expect(() => render(template, {})).toThrow(expected);
    }
  });
});
