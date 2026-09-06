import { describe, expect, test } from "bun:test";
import { render } from "../src/engine";

describe("interpolation", () => {
  test("escapes HTML and supports raw values and missing values", () => {
    const data = { value: `&<>"'`, raw: "<b>ok</b>" };
    expect(render("{{value}}|{{{raw}}}|{{missing}}", data)).toBe(
      "&amp;&lt;&gt;&quot;&#39;|<b>ok</b>|",
    );
  });

  test("preserves whitespace and removes comments", () => {
    expect(render(" a \n{{! ignored }}\t b ", {})).toBe(" a \n\t b ");
  });

  test("rejects non-scalar interpolation", () => {
    expect(() => render("{{user}}", { user: { name: "Ada" } })).toThrow(
      /not scalar text.*line 1, column 1/,
    );
  });
});

describe("blocks", () => {
  test("uses the specified truthiness rules", () => {
    for (const value of ["", 0, false, null, undefined, []]) {
      expect(render("{{#if value}}yes{{else}}no{{/if}}", { value })).toBe("no");
    }
    for (const value of ["0", 1, true, {}, [0], Number.NaN]) {
      expect(render("{{#if value}}yes{{else}}no{{/if}}", { value })).toBe("yes");
    }
  });

  test("iterates, exposes context, and falls back to root", () => {
    const template = "{{#each users}}[{{@index}}:{{name}}/{{site}}]{{else}}empty{{/each}}";
    expect(render(template, { site: "HQ", users: [{ name: "A" }, { name: "B" }] })).toBe(
      "[0:A/HQ][1:B/HQ]",
    );
    expect(render(template, { site: "HQ", users: [] })).toBe("empty");
  });

  test("supports nested loops and blocks", () => {
    const template =
      "{{#each groups}}{{name}}:{{#each members}}{{#if active}}{{this.name}}({{@index}}){{else}}-{{/if}}{{else}}none{{/each}};{{/each}}";
    expect(
      render(template, {
        groups: [
          { name: "G1", members: [{ name: "A", active: true }, { name: "B", active: false }] },
          { name: "G2", members: [] },
        ],
      }),
    ).toBe("G1:A(0)-;G2:none;");
  });

  test("nested loop paths fall back directly to the root", () => {
    const template = "{{#each groups}}{{#each members}}{{label}}{{/each}}{{/each}}";
    expect(
      render(template, {
        label: "root",
        groups: [{ label: "outer", members: [{}] }],
      }),
    ).toBe("root");
  });
});

describe("syntax errors", () => {
  test.each([
    ["{{else}}", /outside.*line 1, column 1/],
    ["{{#if x}}a{{else}}b{{else}}c{{/if}}", /Duplicate.*column 20/],
    ["{{#if x}}{{/each}}", /Mismatched.*column 10/],
    ["x\n{{#wat x}}", /Unknown.*line 2, column 1/],
    ["x{{#if x}}", /Unclosed.*line 1, column 2/],
    ["x{{value", /Unclosed tag.*column 2/],
  ])("reports %s", (template, expected) => {
    expect(() => render(template, {})).toThrow(expected as RegExp);
  });
});
