import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Keep every test artifact within the project directory.
const directory = mkdtempSync(join(process.cwd(), ".test-tmp-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const template = join(directory, "template.txt");
const data = join(directory, "data.json");
const cli = join(import.meta.dir, "../src/cli.ts");

function run(args: string[]) {
  const result = Bun.spawnSync([process.execPath, "run", cli, ...args], {
    stdout: "pipe", stderr: "pipe",
  });
  return {
    code: result.exitCode,
    out: result.stdout.toString(),
    err: result.stderr.toString(),
  };
}

describe("CLI", () => {
  test("reads UTF-8 and writes exact rendered text only", () => {
    writeFileSync(template, "  Héllo {{name}}!\n{{#each items}}{{this}}{{/each}}");
    writeFileSync(data, JSON.stringify({ name: "世界 & 🌍", items: [1, 2] }));
    expect(run([template, data])).toEqual({ code: 0, out: "  Héllo 世界 &amp; 🌍!\n12", err: "" });
  });

  test("writes no bytes for empty output", () => {
    writeFileSync(template, "{{missing}}");
    writeFileSync(data, "{}");
    expect(run([template, data])).toEqual({ code: 0, out: "", err: "" });
  });

  test("rejects incorrect argument counts", () => {
    for (const args of [[], [template], [template, data, "extra"]]) {
      const result = run(args);
      expect(result.code).not.toBe(0);
      expect(result.out).toBe("");
      expect(result.err).toContain("Usage:");
    }
  });

  test("reports missing files on stderr", () => {
    const result = run([join(directory, "missing"), data]);
    expect(result.code).not.toBe(0);
    expect(result.out).toBe("");
    expect(result.err.length).toBeGreaterThan(0);
  });

  test("reports invalid JSON on stderr", () => {
    writeFileSync(template, "hello");
    writeFileSync(data, "{invalid");
    const result = run([template, data]);
    expect(result.code).not.toBe(0);
    expect(result.out).toBe("");
    expect(result.err.length).toBeGreaterThan(0);
  });

  test("reports template errors without partial stdout", () => {
    writeFileSync(template, "partial\n{{/if}}");
    writeFileSync(data, "{}");
    const result = run([template, data]);
    expect(result.code).not.toBe(0);
    expect(result.out).toBe("");
    expect(result.err).toContain("line 2, column 1");
  });

  test("reports scalar errors without partial stdout", () => {
    writeFileSync(template, "partial {{value}}");
    writeFileSync(data, '{"value":{}}');
    const result = run([template, data]);
    expect(result.code).not.toBe(0);
    expect(result.out).toBe("");
    expect(result.err).toContain("Cannot render");
  });
});
