import { describe, expect, test } from "bun:test";
import { render } from "../src/engine";

describe("interpolation", () => {
  test("resolves dotted paths and preserves surrounding whitespace", () => {
    expect(render(" Hello, {{ user.name }}!\n", { user: { name: "Ada" } })).toBe(
      " Hello, Ada!\n",
    );
  });

  test("escapes HTML in double braces and not in triple braces", () => {
    const value = `&<>"'`;
    expect(render("{{value}}|{{{value}}}", { value })).toBe(
      `&amp;&lt;&gt;&quot;&#39;|&<>"'`,
    );
  });

  test("renders missing and null values as empty strings", () => {
    expect(render("a{{missing}}b{{nil}}c", { nil: null })).toBe("abc");
  });

  test("renders scalar primitive values", () => {
    expect(render("{{n}} {{b}} {{big}}", { n: 12, b: false, big: 3n })).toBe(
      "12 false 3",
    );
  });

  test("rejects non-scalar interpolation values", () => {
    expect(() => render("before {{item}}", { item: { x: 1 } })).toThrow(
      /cannot be rendered as scalar text.*line 1, column 8/,
    );
    expect(() => render("{{items}}", { items: [1] })).toThrow(/cannot be rendered/);
  });
});

describe("blocks", () => {
  test("implements the specified truthiness rules", () => {
    for (const value of ["", 0, false, null, undefined, []]) {
      expect(render("{{#if value}}yes{{else}}no{{/if}}", { value })).toBe("no");
    }
    for (const value of ["0", -1, true, {}, [0]]) {
      expect(render("{{#if value}}yes{{else}}no{{/if}}", { value })).toBe("yes");
    }
  });

  test("supports nested conditionals", () => {
    const template = "{{#if outer}}A{{#if inner}}B{{else}}C{{/if}}D{{else}}E{{/if}}";
    expect(render(template, { outer: true, inner: false })).toBe("ACD");
    expect(render(template, { outer: false, inner: true })).toBe("E");
  });

  test("iterates arrays with this, index, local paths, and root fallback", () => {
    const template = "{{#each users}}[{{@index}}:{{name}}/{{site}}/{{this.name}}]{{else}}empty{{/each}}";
    expect(
      render(template, {
        site: "example",
        users: [{ name: "Ada" }, { name: "Lin" }],
      }),
    ).toBe("[0:Ada/example/Ada][1:Lin/example/Lin]");
    expect(render(template, { site: "example", users: [] })).toBe("empty");
    expect(render(template, { site: "example", users: "not an array" })).toBe("empty");
  });

  test("supports nested loops with innermost loop context", () => {
    const template =
      "{{#each groups}}{{name}}:{{#each members}}{{@index}}={{this}};{{/each}}|{{/each}}";
    expect(
      render(template, {
        groups: [
          { name: "A", members: ["x", "y"] },
          { name: "B", members: ["z"] },
        ],
      }),
    ).toBe("A:0=x;1=y;|B:0=z;|");
  });
});

describe("syntax", () => {
  test("removes comments without disturbing other whitespace", () => {
    expect(render("one {{! ignored }} \n two", {})).toBe("one  \n two");
  });

  test("reports structural mistakes with line and column", () => {
    const cases: Array<[string, RegExp]> = [
      ["x\n{{#wat value}}", /Unknown block 'wat'.*line 2, column 1/],
      ["{{#if ok}}\n{{/each}}", /Mismatched closing block.*line 2, column 1/],
      ["{{#if ok}}x", /Unclosed block '#if'.*line 1, column 1/],
      ["x{{else}}", /'else' outside a block.*line 1, column 2/],
      ["{{#if x}}{{else}}{{else}}{{/if}}", /Duplicate 'else'.*line 1, column 18/],
      ["{{/if}}", /no matching opener.*line 1, column 1/],
      ["{{value", /Unclosed template tag.*line 1, column 1/],
    ];
    for (const [template, expected] of cases) {
      expect(() => render(template, { ok: true, x: true })).toThrow(expected);
    }
  });
});
