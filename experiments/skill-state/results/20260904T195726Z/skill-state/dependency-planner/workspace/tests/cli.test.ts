import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const tempDir = join(import.meta.dir, ".tmp");
await mkdir(tempDir, { recursive: true });

afterAll(() => rm(tempDir, { recursive: true, force: true }));

async function invoke(input: unknown, args?: string[]) {
  const path = join(tempDir, `${crypto.randomUUID()}.json`);
  await writeFile(path, typeof input === "string" ? input : JSON.stringify(input));
  const child = Bun.spawn(["bun", "run", "src/cli.ts", ...(args ?? ["plan", path])], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode, path };
}

describe("dependency planner CLI", () => {
  test("produces deterministic scheduling output", async () => {
    const result = await invoke({ tasks: [
      { id: "deploy", duration: 1, dependsOn: ["test", "package"] },
      { id: "test", duration: 2, dependsOn: ["lint"] },
      { id: "package", duration: 2, dependsOn: ["build"] },
      { id: "build", duration: 3 },
      { id: "lint", duration: 3 },
      { id: "docs", duration: 0 },
    ] });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      order: ["build", "docs", "lint", "package", "test", "deploy"],
      layers: [["build", "docs", "lint"], ["package", "test"], ["deploy"]],
      earliest: {
        build: { start: 0, finish: 3 },
        docs: { start: 0, finish: 0 },
        lint: { start: 0, finish: 3 },
        package: { start: 3, finish: 5 },
        test: { start: 3, finish: 5 },
        deploy: { start: 5, finish: 6 },
      },
      totalDuration: 6,
      criticalPath: ["build", "package", "deploy"],
    });
  });

  test("handles an empty graph", async () => {
    const result = await invoke({ tasks: [] });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      order: [], layers: [], earliest: {}, totalDuration: 0, criticalPath: [],
    });
  });

  test("chooses the lexicographically smallest full critical path", async () => {
    const result = await invoke({ tasks: [
      { id: "z", duration: 0 },
      { id: "a", duration: 0, dependsOn: ["z"] },
      { id: "b", duration: 0 },
    ] });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).criticalPath).toEqual(["b"]);
  });

  test("reports a deterministic concrete cycle", async () => {
    const result = await invoke({ tasks: [
      { id: "c", duration: 1, dependsOn: ["b"] },
      { id: "b", duration: 1, dependsOn: ["a"] },
      { id: "a", duration: 1, dependsOn: ["c"] },
    ] });
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("a -> c -> b -> a");
  });

  test.each([
    ["malformed JSON", "{", "invalid JSON"],
    ["missing tasks", {}, "tasks"],
    ["duplicate ids", { tasks: [{ id: "a", duration: 1 }, { id: "a", duration: 2 }] }, "duplicate"],
    ["bad duration", { tasks: [{ id: "a", duration: -1 }] }, "duration"],
    ["null dependencies", { tasks: [{ id: "a", duration: 1, dependsOn: null }] }, "dependsOn"],
    ["duplicate dependencies", { tasks: [{ id: "a", duration: 1 }, { id: "b", duration: 1, dependsOn: ["a", "a"] }] }, "duplicate"],
    ["unknown dependency", { tasks: [{ id: "a", duration: 1, dependsOn: ["x"] }] }, "unknown"],
    ["self dependency", { tasks: [{ id: "a", duration: 1, dependsOn: ["a"] }] }, "itself"],
  ])("rejects %s", async (_name, input, message) => {
    const result = await invoke(input);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(message);
  });

  test("rejects unknown commands and flags", async () => {
    const command = await invoke({}, ["show", "input.json"]);
    const flag = await invoke({}, ["plan", "--help"]);
    expect(command.exitCode).not.toBe(0);
    expect(flag.exitCode).not.toBe(0);
    expect(command.stderr).toContain("usage:");
    expect(flag.stderr).toContain("usage:");
  });
});
