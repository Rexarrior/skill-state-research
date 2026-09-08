import { describe, expect, test } from "bun:test";
import { render } from "../src/engine";

describe("interpolation", () => {
  test("escapes all HTML characters and supports raw insertion", () => {
    expect(render("{{value}}|{{{ value }}}", { value: `&<>"'` }))
      .toBe("&amp;&lt;&gt;&quot;&#39;|&<>\"'");
  });
  test("preserves whitespace and removes comments", () => {
    expect(render(" \r\n\t{{! ignored }} x\n ", {})).toBe(" \r\n\t x\n ");
    expect(render("", {})).toBe("");
    expect(render("plain { text }", {})).toBe("plain { text }");
  });
  test("resolves nested and numeric paths and handles scalar values", () => {
    expect(render("{{users.0.name}} {{zero}} {{no}} {{missing}}/{{nil}}", {
      users: [{ name: "Ada" }], zero: 0, no: false, nil: null,
    })).toBe("Ada 0 false /");
    expect(render("{{this}}", 42)).toBe("42");
    expect(render("{{this}}", undefined)).toBe("");
    expect(render("{{this}}", 12n)).toBe("12");
  });
  test("does not expose prototype properties", () => {
    expect(render("{{toString}}/{{constructor}}/{{hidden}}", Object.create({ hidden: "secret" })))
      .toBe("//");
  });
  for (const value of [{}, [], () => "bad"]) {
    test(`rejects non-scalar ${typeof value} in escaped and raw tags`, () => {
      for (const template of ["\n  {{value}}", "\n  {{{value}}}"]) {
        expect(() => render(template, { value })).toThrow(/Cannot render.*scalar text.*line 2, column 3/);
      }
    });
  }
});

describe("blocks", () => {
  for (const value of ["", 0, false, null, undefined, [], NaN]) {
    test(`false branch for ${String(value)}`, () => {
      expect(render("{{#if value}}yes{{else}}no{{/if}}", { value })).toBe("no");
    });
  }
  for (const value of ["0", 1, true, {}, [0]]) {
    test(`true branch for ${String(value)}`, () => {
      expect(render("{{#if value}}yes{{else}}no{{/if}}", { value })).toBe("yes");
    });
  }
  test("nested conditions and optional else", () => {
    expect(render("{{#if a}}A{{#if b}}B{{else}}C{{/if}}{{else}}D{{/if}}", { a: true, b: false })).toBe("AC");
    expect(render("a{{#if missing}}b{{/if}}c", {})).toBe("ac");
  });
  test("loops resolve local paths and fall back to root", () => {
    expect(render("{{#each items}}{{@index}}:{{name}}:{{title}}:{{this.name}};{{/each}}", {
      title: "root", items: [{ name: "A" }, { name: "B", title: "local" }],
    })).toBe("0:A:root:A;1:B:local:B;");
    expect(render("{{#each items}}[{{this}}]{{/each}}", { items: [0, false, "x", null] })).toBe("[0][false][x][]");
  });
  test("nested loops restore context and work with conditions", () => {
    const template = "{{#each groups}}{{@index}}={{#each this}}{{#if this}}{{@index}}:{{this}}:{{title}};{{/if}}{{/each}}/{{@index}}|{{/each}}";
    expect(render(template, { title: "R", groups: [["a", "b"], ["c"]] }))
      .toBe("0=0:a:R;1:b:R;/0|1=0:c:R;/1|");
  });
  test("each else handles empty and non-array values and retains context", () => {
    for (const items of [[], null, undefined, false, {}, "abc", 1]) {
      expect(render("{{#each items}}yes{{else}}{{title}}{{/each}}", { items, title: "empty" })).toBe("empty");
    }
    expect(render("{{#each items}}{{#each children}}x{{else}}{{name}}:{{@index}}{{/each}}{{/each}}", {
      items: [{ name: "A", children: [] }],
    })).toBe("A:0");
  });
  test("present undefined values and explicit this paths do not fall back", () => {
    expect(render("{{#each items}}{{name}}/{{this.title}}/{{title}}{{/each}}", {
      name: "root", title: "R", items: [{ name: undefined }],
    })).toBe("//R");
  });
});

describe("syntax errors", () => {
  const cases: [string, RegExp][] = [
    ["{{#unknown x}}", /Unknown block/],
    ["{{#if x}}{{/each}}", /Mismatched closing/],
    ["{{/if}}", /Unexpected closing/],
    ["{{#if x}}", /Unclosed if block/],
    ["{{#each x}}", /Unclosed each block/],
    ["{{#if x}}{{else}}{{else}}{{/if}}", /Duplicate else/],
    ["{{else}}", /else outside/],
    ["{{value", /Unclosed tag/],
    ["{{{value}}", /Unclosed tag/],
    ["{{#if}}", /Invalid path/],
    ["{{a..b}}", /Invalid path/],
    ["{{}}", /Invalid path/],
  ];
  for (const [template, message] of cases) {
    test(template, () => {
      expect(() => render(template, {})).toThrow(message);
      expect(() => render(template, {})).toThrow(/line \d+, column \d+/);
    });
  }
  test("reports precise location and validates unused branches", () => {
    expect(() => render("first\n  {{else}}", {})).toThrow("line 2, column 3");
    expect(() => render("{{#if missing}}{{#bad x}}{{/bad}}{{/if}}", {})).toThrow(/Unknown block/);
  });
});
