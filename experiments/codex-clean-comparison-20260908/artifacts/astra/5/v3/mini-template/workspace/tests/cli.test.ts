import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

const project = join(import.meta.dir, "..");
const fixtures = join(project, `.test-fixtures-${process.pid}`);
beforeAll(async () => {
  await mkdir(fixtures, { recursive: true });
  await Bun.write(join(fixtures, "template.txt"), "Héllo {{name}}!\n");
  await Bun.write(join(fixtures, "data.json"), JSON.stringify({ name: "世界 & friends" }));
  await Bun.write(join(fixtures, "invalid.json"), "{broken");
  await Bun.write(join(fixtures, "bad.txt"), "{{#if name}}");
  await Bun.write(join(fixtures, "object.json"), '{"name":{}}');
});
afterAll(() => rm(fixtures, { recursive: true, force: true }));

function cli(args: string[]) {
  const result = Bun.spawnSync([process.execPath, "run", "src/cli.ts", ...args], {
    cwd: project, stdout: "pipe", stderr: "pipe",
  });
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
}

test("CLI writes exact UTF-8 output", () => {
  const result = cli([join(fixtures, "template.txt"), join(fixtures, "data.json")]);
  expect(result).toEqual({ code: 0, out: "Héllo 世界 &amp; friends!\n", err: "" });
});

test("CLI rejects wrong arguments, missing files, invalid JSON and render errors", () => {
  for (const args of [
    [], ["one"], ["one", "two", "three"],
    [join(fixtures, "missing"), join(fixtures, "data.json")],
    [join(fixtures, "template.txt"), join(fixtures, "invalid.json")],
    [join(fixtures, "bad.txt"), join(fixtures, "data.json")],
    [join(fixtures, "template.txt"), join(fixtures, "object.json")],
  ]) {
    const result = cli(args);
    expect(result.code).not.toBe(0);
    expect(result.out).toBe("");
    expect(result.err.length).toBeGreaterThan(0);
  }
});
