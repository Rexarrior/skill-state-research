import { describe, expect, test } from "bun:test";
import { render, TemplateError } from "../src/engine";

describe("render", () => {
  test("interpolates escaped and raw scalar values", () => {
    const data = { value: `&<>"'`, count: 0, absent: undefined };
    expect(render("{{value}}|{{{value}}}|{{count}}|{{absent}}", data)).toBe(
      "&amp;&lt;&gt;&quot;&#39;|&<>\"'|0|",
    );
  });

  test("preserves whitespace and removes comments", () => {
    expect(render(" a\n{{! ignored }}  b ", {})).toBe(" a\n  b ");
  });

  test("handles nested conditionals and specified truthiness", () => {
    expect(render("{{#if yes}}Y{{#if no}}N{{else}}!{{/if}}{{else}}X{{/if}}", {
      yes: [1], no: [],
    })).toBe("Y!");
    for (const value of ["", 0, false, null, undefined, []]) {
      expect(render("{{#if value}}yes{{else}}no{{/if}}", { value })).toBe("no");
    }
    expect(render("{{#if value}}yes{{else}}no{{/if}}", { value: {} })).toBe("yes");
  });

  test("iterates nested arrays with local lookup, root fallback, this, and index", () => {
    const template = "{{#each groups}}[{{name}}/{{title}}:{{#each items}}{{@index}}={{this}};{{else}}empty{{/each}}]{{/each}}";
    expect(render(template, {
      title: "root",
      groups: [
        { name: "A", items: ["x", "y"] },
        { name: "B", items: [] },
      ],
    })).toBe("[A/root:0=x;1=y;][B/root:empty]");
  });

  test("each else also handles missing and non-array values", () => {
    expect(render("{{#each value}}bad{{else}}empty{{/each}}", {})).toBe("empty");
    expect(render("{{#each value}}bad{{else}}empty{{/each}}", { value: "no" })).toBe("empty");
  });

  test("rejects non-scalar interpolation", () => {
    expect(() => render("before {{value}}", { value: { nested: true } })).toThrow(
      "Cannot render object value as text at line 1, column 8",
    );
  });

  test.each([
    ["{{#wat x}}{{/wat}}", "Unknown block \"wat\" at line 1, column 1"],
    ["{{else}}", "{{else}} outside a block at line 1, column 1"],
    ["{{#if x}}{{else}}{{else}}{{/if}}", "Duplicate {{else}} at line 1, column 18"],
    ["{{#if x}}{{/each}}", "Mismatched closing block"],
    ["x\n{{#if x}}", "Unclosed {{#if}} block at line 2, column 1"],
    ["x\n{{value", "Unclosed tag at line 2, column 1"],
  ])("reports structural error for %s", (template, message) => {
    expect(() => render(template, {})).toThrow(message);
    try {
      render(template, {});
    } catch (error) {
      expect(error).toBeInstanceOf(TemplateError);
    }
  });
});

describe("CLI", () => {
  test("renders UTF-8 files to stdout", async () => {
    const directory = await import("node:fs/promises").then((fs) => fs.mkdtemp("/tmp/mini-template-"));
    const templatePath = `${directory}/template.txt`;
    const dataPath = `${directory}/data.json`;
    await Bun.write(templatePath, "Привет, {{name}}!");
    await Bun.write(dataPath, JSON.stringify({ name: "мир" }));

    const process = Bun.spawn(["bun", "run", "src/cli.ts", templatePath, dataPath], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await process.exited).toBe(0);
    expect(await new Response(process.stdout).text()).toBe("Привет, мир!");
    expect(await new Response(process.stderr).text()).toBe("");
  });

  test("reports errors on stderr and exits non-zero", async () => {
    const process = Bun.spawn(["bun", "run", "src/cli.ts"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await process.exited).not.toBe(0);
    expect(await new Response(process.stdout).text()).toBe("");
    expect(await new Response(process.stderr).text()).toContain("Usage:");
  });
});
