import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPlan, validateInput } from "../src/cli";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("planner", () => {
  test("uses deterministic order, layers, timings, and path ties", () => {
    const tasks = validateInput({
      tasks: [
        { id: "ship", duration: 1, dependsOn: ["test", "build"] },
        { id: "test", duration: 2, dependsOn: ["lint"] },
        { id: "build", duration: 2, dependsOn: ["lint"] },
        { id: "lint", duration: 1 },
        { id: "docs", duration: 1 },
      ],
    });

    expect(createPlan(tasks)).toEqual({
      order: ["docs", "lint", "build", "test", "ship"],
      layers: [["docs", "lint"], ["build", "test"], ["ship"]],
      earliest: {
        docs: { start: 0, finish: 1 },
        lint: { start: 0, finish: 1 },
        build: { start: 1, finish: 3 },
        test: { start: 1, finish: 3 },
        ship: { start: 3, finish: 4 },
      },
      totalDuration: 4,
      criticalPath: ["lint", "build", "ship"],
    });
  });

  test("handles empty input and zero-duration tasks", () => {
    expect(createPlan(validateInput({ tasks: [] }))).toEqual({
      order: [], layers: [], earliest: {}, totalDuration: 0, criticalPath: [],
    });

    expect(createPlan(validateInput({
      tasks: [
        { id: "b", duration: 0, dependsOn: ["a"] },
        { id: "a", duration: 0 },
      ],
    })).criticalPath).toEqual(["a"]);
  });

  test("validates schema constraints", () => {
    expect(() => validateInput({ tasks: [{ id: "", duration: 1 }] })).toThrow("non-empty");
    expect(() => validateInput({ tasks: [{ id: "a", duration: -1 }] })).toThrow("non-negative");
    expect(() => validateInput({ tasks: [{ id: "a", duration: 1, dependsOn: ["x"] }] })).toThrow("unknown");
    expect(() => validateInput({ tasks: [{ id: "a", duration: 1, dependsOn: ["a"] }] })).toThrow("itself");
  });

  test("reports a deterministic concrete cycle", () => {
    const tasks = validateInput({
      tasks: [
        { id: "b", duration: 1, dependsOn: ["a"] },
        { id: "a", duration: 1, dependsOn: ["b"] },
      ],
    });
    expect(() => createPlan(tasks)).toThrow("a -> b -> a");
  });
});

describe("CLI", () => {
  test("prints exactly one JSON object", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dependency-planner-"));
    temporaryDirectories.push(directory);
    const input = join(directory, "input.json");
    await writeFile(input, JSON.stringify({ tasks: [{ id: "build", duration: 3 }] }));

    const process = Bun.spawn(["bun", "run", "src/cli.ts", "plan", input], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(stdout)).toEqual({
      order: ["build"],
      layers: [["build"]],
      earliest: { build: { start: 0, finish: 3 } },
      totalDuration: 3,
      criticalPath: ["build"],
    });
  });

  test("fails cleanly for malformed JSON and unknown flags", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dependency-planner-"));
    temporaryDirectories.push(directory);
    const input = join(directory, "bad.json");
    await writeFile(input, "{");

    for (const args of [["plan", input], ["--wat"]]) {
      const process = Bun.spawn(["bun", "run", "src/cli.ts", ...args], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        process.exited,
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
      ]);
      expect(exitCode).not.toBe(0);
      expect(stdout).toBe("");
      expect(stderr).not.toBe("");
    }
  });
});
