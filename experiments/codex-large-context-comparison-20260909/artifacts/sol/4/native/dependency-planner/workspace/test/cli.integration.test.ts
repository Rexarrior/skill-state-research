import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const fixtureDirectory = join(tmpdir(), `dependency-planner-${process.pid}`);
const fixturePath = join(fixtureDirectory, "input.json");

beforeAll(async () => {
  await mkdir(fixtureDirectory, { recursive: true });
  await writeFile(fixturePath, JSON.stringify({
    tasks: [
      { id: "build", duration: 3, dependsOn: ["lint"] },
      { id: "lint", duration: 1 },
    ],
  }));
});

afterAll(async () => {
  await rm(fixtureDirectory, { recursive: true, force: true });
});

describe("CLI", () => {
  test("prints exactly one JSON object", () => {
    const result = Bun.spawnSync(["bun", "run", "src/cli.ts", "plan", fixturePath]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
    const output = result.stdout.toString();
    expect(output.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(output)).toMatchObject({
      order: ["lint", "build"],
      totalDuration: 4,
      criticalPath: ["lint", "build"],
    });
  });

  test("rejects malformed JSON with useful stderr", async () => {
    const malformedPath = join(fixtureDirectory, "malformed.json");
    await writeFile(malformedPath, "{");
    const result = Bun.spawnSync(["bun", "run", "src/cli.ts", "plan", malformedPath]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toContain("invalid JSON");
  });

  test("rejects unknown flags", () => {
    const result = Bun.spawnSync(["bun", "run", "src/cli.ts", "--verbose"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain('unknown flag "--verbose"');
  });
});
