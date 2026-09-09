import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const projectRoot = resolve(import.meta.dir, "..");
const cli = join(projectRoot, "src", "cli.ts");
let fixtureDirectory: string;

beforeAll(() => {
  fixtureDirectory = mkdtempSync(join(tmpdir(), "dependency-planner-"));
});

afterAll(() => {
  rmSync(fixtureDirectory, { recursive: true, force: true });
});

function fixture(name: string, value: unknown): string {
  const path = join(fixtureDirectory, name);
  writeFileSync(path, JSON.stringify(value));
  return path;
}

function run(...args: string[]) {
  const result = Bun.spawnSync([process.execPath, "run", cli, ...args], {
    cwd: projectRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

describe("dependency planner CLI", () => {
  test("plans a disconnected graph deterministically", () => {
    const input = fixture("plan.json", {
      tasks: [
        { id: "ship", duration: 1, dependsOn: ["test", "build"] },
        { id: "z-independent", duration: 8 },
        { id: "test", duration: 3, dependsOn: ["lint"] },
        { id: "build", duration: 4, dependsOn: ["lint"] },
        { id: "lint", duration: 2 },
      ],
    });

    const result = run("plan", input);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      order: ["lint", "build", "test", "ship", "z-independent"],
      layers: [["lint", "z-independent"], ["build", "test"], ["ship"]],
      earliest: {
        lint: { start: 0, finish: 2 },
        build: { start: 2, finish: 6 },
        test: { start: 2, finish: 5 },
        ship: { start: 6, finish: 7 },
        "z-independent": { start: 0, finish: 8 },
      },
      totalDuration: 8,
      criticalPath: ["z-independent"],
    });
  });

  test("chooses the lexicographically smallest complete critical path", () => {
    const input = fixture("tie.json", {
      tasks: [
        { id: "end", duration: 1, dependsOn: ["right", "left"] },
        { id: "right", duration: 2 },
        { id: "left", duration: 2 },
      ],
    });

    expect(JSON.parse(run("plan", input).stdout).criticalPath).toEqual([
      "left",
      "end",
    ]);
  });

  test("handles empty graphs and zero-duration dependency chains", () => {
    const empty = fixture("empty.json", { tasks: [] });
    expect(JSON.parse(run("plan", empty).stdout)).toEqual({
      order: [],
      layers: [],
      earliest: {},
      totalDuration: 0,
      criticalPath: [],
    });

    const zero = fixture("zero.json", {
      tasks: [
        { id: "a", duration: 0 },
        { id: "b", duration: 0, dependsOn: ["a"] },
      ],
    });
    const zeroPlan = JSON.parse(run("plan", zero).stdout);
    expect(zeroPlan.layers).toEqual([["a"], ["b"]]);
    expect(zeroPlan.earliest.b).toEqual({ start: 0, finish: 0 });
    expect(zeroPlan.totalDuration).toBe(0);
    expect(zeroPlan.criticalPath).toEqual(["a"]);
  });

  test("accepts task ids that match object prototype properties", () => {
    const input = fixture("prototype-ids.json", {
      tasks: [
        { id: "__proto__", duration: 2 },
        { id: "constructor", duration: 1, dependsOn: ["__proto__"] },
      ],
    });

    const result = run("plan", input);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      order: ["__proto__", "constructor"],
      layers: [["__proto__"], ["constructor"]],
      earliest: {
        ["__proto__"]: { start: 0, finish: 2 },
        constructor: { start: 2, finish: 3 },
      },
      totalDuration: 3,
      criticalPath: ["__proto__", "constructor"],
    });
  });

  test("reports a deterministic concrete cycle", () => {
    const input = fixture("cycle.json", {
      tasks: [
        { id: "c", duration: 1, dependsOn: ["b"] },
        { id: "b", duration: 1, dependsOn: ["a"] },
        { id: "a", duration: 1, dependsOn: ["c"] },
      ],
    });

    const result = run("plan", input);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("dependency cycle: a -> c -> b -> a");
  });

  test("rejects schema errors", () => {
    const invalidInputs = [
      [{ id: "a", duration: 1 }],
      { tasks: [{ id: "", duration: 1 }] },
      { tasks: [{ id: "a", duration: -1 }] },
      { tasks: [{ id: "a", duration: 1 }, { id: "a", duration: 2 }] },
      { tasks: [{ id: "a", duration: 1, dependsOn: ["missing"] }] },
      { tasks: [{ id: "a", duration: 1, dependsOn: ["a"] }] },
      { tasks: [{ id: "a", duration: 1, dependsOn: ["x", "x"] }] },
    ];

    for (const [index, value] of invalidInputs.entries()) {
      const result = run("plan", fixture(`invalid-${index}.json`, value));
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toStartWith("error: ");
    }
  });

  test("rejects invalid JSON, unknown commands, and extra flags", () => {
    const malformed = join(fixtureDirectory, "malformed.json");
    writeFileSync(malformed, "{not json");
    expect(run("plan", malformed).stderr).toContain("invalid JSON");

    const valid = fixture("valid.json", { tasks: [] });
    expect(run("unknown", valid).stderr).toContain("unknown command");
    expect(run("plan", valid, "--extra").stderr).toContain(
      "unknown argument or flag",
    );
  });
});
