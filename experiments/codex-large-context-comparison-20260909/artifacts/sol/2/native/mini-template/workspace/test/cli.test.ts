import { describe, expect, test } from "bun:test";

const decoder = new TextDecoder();

describe("CLI", () => {
  test("writes only rendered output to stdout", () => {
    const result = Bun.spawnSync([
      process.execPath,
      "run",
      "src/cli.ts",
      "test/fixtures/greeting.template",
      "test/fixtures/greeting.json",
    ]);

    expect(result.exitCode).toBe(0);
    expect(decoder.decode(result.stdout)).toBe("Hello, &lt;Ada&gt;!\n");
    expect(decoder.decode(result.stderr)).toBe("");
  });

  test("reports errors on stderr and exits non-zero", () => {
    const result = Bun.spawnSync([process.execPath, "run", "src/cli.ts"]);

    expect(result.exitCode).not.toBe(0);
    expect(decoder.decode(result.stdout)).toBe("");
    expect(decoder.decode(result.stderr)).toContain("Usage:");
  });
});
