import { describe, expect, test } from "bun:test";
import { createPlan, validateInput } from "../src/cli";

const cli = new URL("../src/cli.ts", import.meta.url).pathname;

async function runCli(...args: string[]) {
  const process = Bun.spawn(["bun", "run", cli, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

describe("dependency planner", () => {
  test("plans a graph deterministically and compares full critical paths", () => {
    const tasks = validateInput({
      tasks: [
        { id: "end", duration: 1, dependsOn: ["y", "z"] },
        { id: "z", duration: 1, dependsOn: ["a"] },
        { id: "y", duration: 1, dependsOn: ["b"] },
        { id: "b", duration: 1 },
        { id: "a", duration: 1 },
      ],
    });

    expect(createPlan(tasks)).toEqual({
      order: ["a", "b", "y", "z", "end"],
      layers: [["a", "b"], ["y", "z"], ["end"]],
      earliest: {
        a: { start: 0, finish: 1 },
        b: { start: 0, finish: 1 },
        end: { start: 2, finish: 3 },
        y: { start: 1, finish: 2 },
        z: { start: 1, finish: 2 },
      },
      totalDuration: 3,
      criticalPath: ["a", "z", "end"],
    });
  });

  test("supports empty input and zero-duration disconnected tasks", () => {
    expect(createPlan(validateInput({ tasks: [] }))).toEqual({
      order: [],
      layers: [],
      earliest: {},
      totalDuration: 0,
      criticalPath: [],
    });

    const plan = createPlan(
      validateInput({ tasks: [{ id: "b", duration: 0 }, { id: "a", duration: 0 }] }),
    );
    expect(plan.totalDuration).toBe(0);
    expect(plan.order).toEqual(["a", "b"]);
    expect(plan.criticalPath).toEqual(["a"]);

    const zeroChain = createPlan(
      validateInput({
        tasks: [
          { id: "z", duration: 0 },
          { id: "a", duration: 0, dependsOn: ["z"] },
        ],
      }),
    );
    expect(zeroChain.criticalPath).toEqual(["a"]);
  });

  test("preserves object-prototype-like task ids in output", () => {
    const plan = createPlan(
      validateInput({
        tasks: [
          { id: "constructor", duration: 1 },
          { id: "__proto__", duration: 2 },
        ],
      }),
    );
    const serialized = JSON.parse(JSON.stringify(plan)).earliest;
    expect(Object.keys(serialized).sort()).toEqual(["__proto__", "constructor"]);
    expect(serialized["__proto__"]).toEqual({ start: 0, finish: 2 });
    expect(serialized.constructor).toEqual({ start: 0, finish: 1 });
  });

  test("reports a deterministic concrete cycle", () => {
    const tasks = validateInput({
      tasks: [
        { id: "c", duration: 1, dependsOn: ["a"] },
        { id: "b", duration: 1, dependsOn: ["c"] },
        { id: "a", duration: 1, dependsOn: ["b"] },
      ],
    });
    expect(() => createPlan(tasks)).toThrow("a -> b -> c -> a");
  });

  test("rejects invalid schema", () => {
    expect(() => validateInput({ tasks: [{ id: "a", duration: -1 }] })).toThrow(
      "finite non-negative",
    );
    expect(() =>
      validateInput({
        tasks: [
          { id: "a", duration: 1, dependsOn: ["missing"] },
        ],
      }),
    ).toThrow("unknown id");
    expect(() =>
      validateInput({
        tasks: [
          { id: "a", duration: 1 },
          { id: "a", duration: 2 },
        ],
      }),
    ).toThrow("duplicate task id");
  });
  test("prints exactly one JSON object through the CLI", async () => {
    const result = await runCli("plan", new URL("fixtures/valid.json", import.meta.url).pathname);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toEqual({
      order: ["lint", "build"],
      layers: [["lint"], ["build"]],
      earliest: {
        build: { start: 2, finish: 5 },
        lint: { start: 0, finish: 2 },
      },
      totalDuration: 5,
      criticalPath: ["lint", "build"],
    });
  });

  test("CLI failures use stderr and a non-zero status", async () => {
    const unknownFlag = await runCli("plan", "--wat");
    expect(unknownFlag.exitCode).not.toBe(0);
    expect(unknownFlag.stdout).toBe("");
    expect(unknownFlag.stderr).toContain("unknown flag: --wat");

    const cycle = await runCli("plan", new URL("fixtures/cycle.json", import.meta.url).pathname);
    expect(cycle.exitCode).not.toBe(0);
    expect(cycle.stdout).toBe("");
    expect(cycle.stderr).toContain("a -> b -> a");
  });
});
