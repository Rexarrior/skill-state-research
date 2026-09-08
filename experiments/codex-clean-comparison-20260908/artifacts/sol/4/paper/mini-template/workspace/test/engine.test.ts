import { describe, expect, test } from "bun:test";
import { render } from "../src/engine";

describe("render", () => {
  test("escapes normal interpolation and leaves triple interpolation raw", () => {
    const data = { value: `&<>"'` };
    expect(render("{{value}} {{{value}}}", data)).toBe("&amp;&lt;&gt;&quot;&#39; &<>\"'");
  });

  test("keeps whitespace, removes comments, and empties missing values", () => {
    expect(render(" a\n{{! ignored }} {{missing}} b ", {})).toBe(" a\n  b ");
  });

  test("renders nested conditionals and specified false values", () => {
    const template = "{{#if outer}}A{{#if inner}}B{{else}}C{{/if}}{{else}}D{{/if}}";
    expect(render(template, { outer: true, inner: [] })).toBe("AC");
    for (const value of ["", 0, false, null, undefined, []]) {
      expect(render("{{#if value}}yes{{else}}no{{/if}}", { value })).toBe("no");
    }
    expect(render("{{#if value}}yes{{/if}}", { value: {} })).toBe("yes");
  });

  test("iterates nested arrays with local values, indexes, and root fallback", () => {
    const template = "{{#each groups}}[{{name}}/{{title}}:{{#each values}}{{@index}}={{this}};{{else}}empty{{/each}}]{{/each}}";
    const data = {
      title: "root",
      groups: [
        { name: "a", values: [1, 2] },
        { name: "b", values: [] },
      ],
    };
    expect(render(template, data)).toBe("[a/root:0=1;1=2;][b/root:empty]");
  });

  test("rejects structural mistakes with line and column", () => {
    expect(() => render("x\n{{#wat x}}", {})).toThrow(/Unknown or invalid block 'wat'.*line 2, column 1/);
    expect(() => render("{{#if x}}{{/each}}", {})).toThrow(/Mismatched closing block/);
    expect(() => render("{{#if x}}", {})).toThrow(/Unclosed 'if' block.*line 1, column 1/);
    expect(() => render("{{else}}", {})).toThrow(/outside a block/);
    expect(() => render("{{#if x}}{{else}}{{else}}{{/if}}", {})).toThrow(/Duplicate 'else'/);
  });

  test("rejects object and function interpolation", () => {
    expect(() => render("{{value}}", { value: {} })).toThrow(/not renderable as scalar text/);
    expect(() => render("{{value}}", { value: () => 1 })).toThrow(/not renderable as scalar text/);
  });
});

test("CLI renders files and writes only output to stdout", async () => {
  const directory = await Bun.$`mktemp -d`.text();
  const path = directory.trim();
  await Bun.write(`${path}/template.txt`, "Hello, {{name}}!");
  await Bun.write(`${path}/data.json`, JSON.stringify({ name: "Ada" }));
  const process = Bun.spawn(["bun", "run", "src/cli.ts", `${path}/template.txt`, `${path}/data.json`], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await process.exited).toBe(0);
  expect(await new Response(process.stdout).text()).toBe("Hello, Ada!");
  expect(await new Response(process.stderr).text()).toBe("");
});
