import { describe, expect, test } from "bun:test";
import { createPlan, validateInput } from "../src/cli";

describe("dependency planner", () => {
  test("plans deterministically with parallel layers and a lexical critical-path tie", () => {
    const tasks = validateInput({
      tasks: [
        { id: "ship", duration: 1, dependsOn: ["build", "docs"] },
        { id: "lint", duration: 2 },
        { id: "docs", duration: 3 },
        { id: "build", duration: 3, dependsOn: ["lint"] },
        { id: "test", duration: 3, dependsOn: ["lint"] },
      ],
    });

    expect(createPlan(tasks)).toEqual({
      order: ["docs", "lint", "build", "ship", "test"],
      layers: [["docs", "lint"], ["build", "test"], ["ship"]],
      earliest: {
        docs: { start: 0, finish: 3 },
        lint: { start: 0, finish: 2 },
        build: { start: 2, finish: 5 },
        ship: { start: 5, finish: 6 },
        test: { start: 2, finish: 5 },
      },
      totalDuration: 6,
      criticalPath: ["lint", "build", "ship"],
    });
  });

  test("uses the lexicographically smallest full critical path", () => {
    const tasks = validateInput({ tasks: [
      { id: "z", duration: 2 },
      { id: "a", duration: 2 },
      { id: "end", duration: 1, dependsOn: ["z", "a"] },
    ] });
    expect(createPlan(tasks).criticalPath).toEqual(["a", "end"]);
  });

  test("uses code-unit lexical ordering independent of locale", () => {
    const tasks = validateInput({ tasks: [
      { id: "a", duration: 1 },
      { id: "Z", duration: 1 },
      { id: "end", duration: 1, dependsOn: ["a", "Z"] },
    ] });
    const plan = createPlan(tasks);
    expect(plan.order).toEqual(["Z", "a", "end"]);
    expect(plan.criticalPath).toEqual(["Z", "end"]);
  });

  test("handles empty input and zero-duration disconnected tasks", () => {
    expect(createPlan(validateInput({ tasks: [] }))).toEqual({
      order: [], layers: [], earliest: {}, totalDuration: 0, criticalPath: [],
    });
    const plan = createPlan(validateInput({ tasks: [
      { id: "b", duration: 0, dependsOn: ["a"] },
      { id: "a", duration: 0 },
      { id: "c", duration: 0 },
    ] }));
    expect(plan.totalDuration).toBe(0);
    expect(plan.criticalPath).toEqual(["a"]);
    expect(plan.layers).toEqual([["a", "c"], ["b"]]);
  });

  test("reports a deterministic concrete cycle", () => {
    const tasks = validateInput({ tasks: [
      { id: "c", duration: 1, dependsOn: ["a"] },
      { id: "b", duration: 1, dependsOn: ["a"] },
      { id: "a", duration: 1, dependsOn: ["b", "c"] },
    ] });
    expect(() => createPlan(tasks)).toThrow("cycle detected: a -> b -> a");
  });

  test.each([
    [{}, '"tasks" must be an array'],
    [{ tasks: [{ id: "", duration: 1 }] }, "non-empty string"],
    [{ tasks: [{ id: "a", duration: Number.NaN }] }, "finite non-negative"],
    [{ tasks: [{ id: "a", duration: -1 }] }, "finite non-negative"],
    [{ tasks: [{ id: "a", duration: 1 }, { id: "a", duration: 2 }] }, "duplicate task id"],
    [{ tasks: [{ id: "a", duration: 1, dependsOn: ["x"] }] }, "unknown dependency"],
    [{ tasks: [{ id: "a", duration: 1, dependsOn: ["a"] }] }, "cannot depend on itself"],
    [{ tasks: [{ id: "a", duration: 1, dependsOn: ["b", "b"] }, { id: "b", duration: 1 }] }, "contains duplicate"],
  ])("rejects invalid schema %#", (input, message) => {
    expect(() => validateInput(input)).toThrow(message as string);
  });
});

describe("CLI", () => {
  test("prints exactly one JSON object", async () => {
    const file = `${import.meta.dir}/fixture-${process.pid}.json`;
    await Bun.write(file, JSON.stringify({ tasks: [{ id: "a", duration: 2 }] }));
    try {
      const process = Bun.spawn(["bun", "run", "src/cli.ts", "plan", file], {
        cwd: `${import.meta.dir}/..`, stdout: "pipe", stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited,
      ]);
      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      expect(stdout.trim().split("\n")).toHaveLength(1);
      expect(JSON.parse(stdout)).toEqual({
        order: ["a"], layers: [["a"]], earliest: { a: { start: 0, finish: 2 } },
        totalDuration: 2, criticalPath: ["a"],
      });
    } finally {
      await Bun.file(file).delete();
    }
  });

  test("fails non-zero for bad commands and invalid JSON", async () => {
    const badCommand = Bun.spawn(["bun", "run", "src/cli.ts", "wat"], {
      cwd: `${import.meta.dir}/..`, stdout: "pipe", stderr: "pipe",
    });
    expect(await badCommand.exited).not.toBe(0);
    expect(await new Response(badCommand.stderr).text()).toContain("unknown command");

    const file = `${import.meta.dir}/invalid-${process.pid}.json`;
    await Bun.write(file, "{");
    try {
      const invalid = Bun.spawn(["bun", "run", "src/cli.ts", "plan", file], {
        cwd: `${import.meta.dir}/..`, stdout: "pipe", stderr: "pipe",
      });
      expect(await invalid.exited).not.toBe(0);
      expect(await new Response(invalid.stderr).text()).toContain("invalid JSON");
    } finally {
      await Bun.file(file).delete();
    }
  });
});
