import { describe, expect, test } from "bun:test";
import { render } from "../src/engine";

describe("interpolation", () => {
  test("preserves all literal whitespace and empty input", () => {
    expect(render("", {})).toBe("");
    expect(render(" \tHello\r\n\nworld  \n", {})).toBe(" \tHello\r\n\nworld  \n");
    expect(render("A {{! ignored }} \n B", {})).toBe("A  \n B");
  });

  test("escapes all five HTML characters, once, with a raw alternative", () => {
    expect(render("{{ value }}|{{{ value }}}", { value: `&<>"'&amp;` }))
      .toBe(`&amp;&lt;&gt;&quot;&#39;&amp;amp;|&<>"'&amp;`);
  });

  test("resolves dotted paths and scalar values", () => {
    expect(render("{{user.name}} {{list.0}} {{zero}} {{flag}} {{big}}", {
      user: { name: "Ada" }, list: ["first"], zero: 0, flag: false, big: 42n,
    })).toBe("Ada first 0 false 42");
    expect(render("{{this}}", "root")).toBe("root");
    expect(render("{{this.name}}", { name: "Ada" })).toBe("Ada");
  });

  test("missing, null, and undefined values are empty", () => {
    expect(render("{{missing}}|{{nil}}|{{absent}}|{{nil.deep}}|{{@index}}", {
      nil: null, absent: undefined,
    })).toBe("||||");
    expect(render("{{x.y}}", null)).toBe("");
  });

  test("ignores inherited properties but allows own properties", () => {
    const data = Object.assign(Object.create({ secret: "hidden" }), { own: "visible" });
    expect(render("{{secret}}/{{own}}/{{toString}}/{{__proto__.secret}}", data)).toBe("/visible//");
    expect(render("{{constructor}}", { constructor: "own" })).toBe("own");
  });

  test("rejects objects, arrays, and functions with location in raw and escaped tags", () => {
    for (const value of [{}, [], () => "hello", new Date()]) {
      for (const tag of ["{{value}}", "{{{value}}}"]) {
        expect(() => render(`first\n  ${tag}`, { value }))
          .toThrow(/Cannot render "value" as scalar text .*line 2, column 3/);
      }
    }
  });
});

describe("blocks", () => {
  test("uses the specified truthiness", () => {
    for (const value of ["", 0, false, null, undefined, [], NaN, 0n]) {
      expect(render("{{#if value}}yes{{else}}no{{/if}}", { value })).toBe("no");
    }
    for (const value of ["0", 1, -1, true, {}, [false], () => {}]) {
      expect(render("{{#if value}}yes{{else}}no{{/if}}", { value })).toBe("yes");
    }
    expect(render("a{{#if missing}}b{{/if}}c", {})).toBe("ac");
  });

  test("nests conditionals and does not evaluate unused interpolation branches", () => {
    const template = "{{#if a}}A{{#if b}}B{{else}}C{{/if}}{{else}}{{bad}}{{/if}}";
    expect(render(template, { a: true, b: false, bad: {} })).toBe("AC");
    expect(render(template, { a: true, b: true, bad: {} })).toBe("AB");
  });

  test("iterates primitive items with indices, root fallback, and this", () => {
    expect(render("{{#each values}}[{{@index}}:{{this}}:{{title}}]{{/each}}", {
      values: ["a", 0, false, null], title: "T",
    })).toBe("[0:a:T][1:0:T][2:false:T][3::T]");
  });

  test("looks in items first and falls back only for absent paths", () => {
    expect(render("{{#each items}}{{name}}/{{info.label}}/{{this.name}};{{/each}}", {
      name: "root", info: { label: "R" },
      items: [{ name: "local", info: {} }, { name: null }, { name: undefined }, {}],
    })).toBe("local/R/local;/R/;/R/;root/R/;");
  });

  test("nests loops and conditionals, then restores the enclosing item and index", () => {
    const template = "{{#each groups}}{{@index}}:{{name}}[{{#each children}}" +
      "{{@index}}={{this}}-{{title}};{{else}}{{name}}:empty{{/each}}]" +
      "{{#if enabled}}+{{else}}-{{/if}}{{@index}}:{{name}}|{{/each}}";
    expect(render(template, {
      title: "root", groups: [
        { name: "A", enabled: true, children: ["x", "y"] },
        { name: "B", enabled: false, children: [] },
      ],
    })).toBe("0:A[0=x-root;1=y-root;]+0:A|1:B[B:empty]-1:B|");
  });

  test("empty arrays and non-array each values use else", () => {
    for (const value of [[], {}, null, undefined, false, 2, "abc"]) {
      expect(render("{{#each value}}body{{else}}empty{{/each}}", { value })).toBe("empty");
      expect(render("{{#each value}}body{{/each}}", { value })).toBe("");
    }
  });

  test("comments do not create blocks", () => {
    expect(render("{{! #unknown }}{{#if yes}}{{! else }}ok{{/if}}", { yes: true })).toBe("ok");
  });
});

describe("syntax errors", () => {
  const cases: [string, RegExp][] = [
    ["{{#unless x}}", /Unknown block/],
    ["{{/if}}", /Unexpected closing tag/],
    ["{{#if x}}{{/each}}", /Mismatched closing tag/],
    ["{{#each x}}{{/if}}", /Mismatched closing tag/],
    ["{{#if x}}", /Unclosed if block/],
    ["{{#each x}}", /Unclosed each block/],
    ["{{else}}", /else outside a block/],
    ["{{#if x}}{{else}}{{else}}{{/if}}", /Duplicate else/],
    ["{{#each x}}{{else}}{{else}}{{/each}}", /Duplicate else/],
    ["{{#if}}", /Invalid or missing path/],
    ["{{}}", /Invalid or missing path/],
    ["{{a..b}}", /Invalid or missing path/],
    ["{{a b}}", /Invalid or missing path/],
    ["{{value", /Unclosed tag/],
    ["{{{value}}", /Unclosed tag/],
  ];
  for (const [template, message] of cases) {
    test(template, () => {
      expect(() => render(template, {})).toThrow(message);
      expect(() => render(template, {})).toThrow(/line \d+, column \d+/);
    });
  }

  test("reports precise locations including CRLF and opening positions", () => {
    expect(() => render("one\r\n  {{else}}", {})).toThrow("line 2, column 3");
    expect(() => render("\n  {{#if x}}\ntext", {})).toThrow("line 2, column 3");
    expect(() => render("{{#if x}}\n\t{{/each}}", {})).toThrow("line 2, column 2");
  });

  test("validates unused branches too", () => {
    expect(() => render("{{#if no}}{{#unknown x}}{{/unknown}}{{/if}}", {})).toThrow(/Unknown block/);
  });
});
