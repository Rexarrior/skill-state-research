import { describe, expect, test } from "bun:test";
import { planInput, validateInput } from "../src/cli";

async function runCli(...args: string[]) {
  const child = Bun.spawn([process.execPath, "run", "src/cli.ts", ...args], {
    cwd: `${import.meta.dir}/..`,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

describe("dependency planner", () => {
  test("uses lexicographical topological order and computes timing and layers", () => {
    expect(planInput({ tasks: [
      { id: "deploy", duration: 2, dependsOn: ["build", "test"] },
      { id: "test", duration: 4, dependsOn: ["lint"] },
      { id: "build", duration: 3, dependsOn: ["lint"] },
      { id: "lint", duration: 1 },
      { id: "docs", duration: 2 },
    ] })).toEqual({
      order: ["docs", "lint", "build", "test", "deploy"],
      layers: [["docs", "lint"], ["build", "test"], ["deploy"]],
      earliest: {
        docs: { start: 0, finish: 2 },
        lint: { start: 0, finish: 1 },
        build: { start: 1, finish: 4 },
        test: { start: 1, finish: 5 },
        deploy: { start: 5, finish: 7 },
      },
      totalDuration: 7,
      criticalPath: ["lint", "test", "deploy"],
    });
  });

  test("chooses the lexicographically smallest complete critical path", () => {
    expect(planInput({ tasks: [
      { id: "z", duration: 1 },
      { id: "a", duration: 1 },
      { id: "end", duration: 2, dependsOn: ["z", "a"] },
    ] }).criticalPath).toEqual(["a", "end"]);
  });

  test("handles empty input and zero-duration tasks", () => {
    expect(planInput({ tasks: [] })).toEqual({
      order: [], layers: [], earliest: {}, totalDuration: 0, criticalPath: [],
    });
    expect(planInput({ tasks: [{ id: "a", duration: 0 }, { id: "b", duration: 0 }] }).criticalPath)
      .toEqual(["a"]);
  });

  test("a zero-duration dependency can be part of the lexicographically smallest path", () => {
    expect(planInput({ tasks: [
      { id: "a", duration: 0 },
      { id: "b", duration: 0, dependsOn: ["a"] },
      { id: "c", duration: 0 },
    ] }).criticalPath).toEqual(["a"]);
  });

  test("compares complete tied paths when one predecessor path is a prefix", () => {
    expect(planInput({ tasks: [
      { id: "a", duration: 1 },
      { id: "b", duration: 0, dependsOn: ["a"] },
      { id: "z", duration: 1, dependsOn: ["a", "b"] },
    ] }).criticalPath).toEqual(["a", "b", "z"]);
  });

  test("reports a deterministic concrete cycle", () => {
    expect(() => planInput({ tasks: [
      { id: "c", duration: 1, dependsOn: ["b"] },
      { id: "b", duration: 1, dependsOn: ["a"] },
      { id: "a", duration: 1, dependsOn: ["c"] },
    ] })).toThrow("dependency cycle: a -> c -> b -> a");
  });

  test("validates malformed tasks and dependencies", () => {
    expect(() => validateInput(null)).toThrow("input must be a JSON object");
    expect(() => validateInput({})).toThrow('"tasks" must be an array');
    expect(() => validateInput({ tasks: [{ id: "", duration: 1 }] })).toThrow("non-empty string");
    expect(() => validateInput({ tasks: [{ id: "a", duration: -1 }] })).toThrow("finite non-negative");
    expect(() => validateInput({ tasks: [
      { id: "a", duration: 1 }, { id: "a", duration: 2 },
    ] })).toThrow("duplicate task id");
    expect(() => validateInput({ tasks: [{ id: "a", duration: 1, dependsOn: ["x"] }] }))
      .toThrow("depends on unknown task");
    expect(() => validateInput({ tasks: [{ id: "a", duration: 1, dependsOn: ["a"] }] }))
      .toThrow("cannot depend on itself");
    expect(() => validateInput({ tasks: [
      { id: "a", duration: 1 }, { id: "b", duration: 1, dependsOn: ["a", "a"] },
    ] })).toThrow("contains duplicate id");
  });

  test("CLI prints exactly one JSON object", async () => {
    const result = await runCli("plan", "test/fixtures/basic.json");
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.split("\n").filter(Boolean)).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toEqual(planInput({ tasks: [
      { id: "build", duration: 3, dependsOn: ["lint"] },
      { id: "lint", duration: 1 },
    ] }));
  });

  test("CLI rejects invalid JSON and unknown flags on stderr", async () => {
    const malformed = await runCli("plan", "test/fixtures/malformed.json");
    expect(malformed.exitCode).not.toBe(0);
    expect(malformed.stdout).toBe("");
    expect(malformed.stderr).toContain("invalid JSON");

    const flag = await runCli("--wat");
    expect(flag.exitCode).not.toBe(0);
    expect(flag.stdout).toBe("");
    expect(flag.stderr).toContain("unknown flag: --wat");

    const planFlag = await runCli("plan", "--wat");
    expect(planFlag.exitCode).not.toBe(0);
    expect(planFlag.stdout).toBe("");
    expect(planFlag.stderr).toContain("unknown flag: --wat");
  });
});
