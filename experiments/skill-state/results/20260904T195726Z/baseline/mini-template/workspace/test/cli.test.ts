import { expect, test } from "bun:test";

test("CLI renders files to stdout without diagnostics", () => {
  const root = `${import.meta.dir}/..`;
  const result = Bun.spawnSync([
    process.execPath,
    "run",
    "src/cli.ts",
    "test/fixtures/example.template",
    "test/fixtures/example.json",
  ], { cwd: root });

  expect(result.exitCode).toBe(0);
  expect(result.stderr.toString()).toBe("");
  expect(result.stdout.toString()).toBe("Hello, &lt;Ada&gt;! 0:one 1:two \n");
});
