import { afterEach, expect, test } from "bun:test";

const temporaryFiles: string[] = [];

function writeInput(value: unknown): string {
  const path = `${import.meta.dir}/../.test-input-${crypto.randomUUID()}.json`;
  Bun.write(path, JSON.stringify(value));
  temporaryFiles.push(path);
  return path;
}

function run(...arguments_: string[]) {
  return Bun.spawnSync(["bun", "run", `${import.meta.dir}/cli.ts`, ...arguments_]);
}

afterEach(() => {
  for (const path of temporaryFiles.splice(0)) Bun.file(path).delete();
});

test("plans dependencies, layers, timings, and critical path", () => {
  const input = writeInput({
    tasks: [
      { id: "deploy", duration: 1, dependsOn: ["build", "docs"] },
      { id: "lint", duration: 2 },
      { id: "docs", duration: 0, dependsOn: ["lint"] },
      { id: "build", duration: 3, dependsOn: ["lint"] },
      { id: "alpha", duration: 4 },
    ],
  });

  const result = run("plan", input);
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(new TextDecoder().decode(result.stdout))).toEqual({
    order: ["alpha", "lint", "build", "docs", "deploy"],
    layers: [["alpha", "lint"], ["build", "docs"], ["deploy"]],
    earliest: {
      alpha: { start: 0, finish: 4 },
      lint: { start: 0, finish: 2 },
      build: { start: 2, finish: 5 },
      docs: { start: 2, finish: 2 },
      deploy: { start: 5, finish: 6 },
    },
    totalDuration: 6,
    criticalPath: ["lint", "build", "deploy"],
  });
});

test("uses the lexicographically smallest complete critical path on ties", () => {
  const input = writeInput({
    tasks: [
      { id: "z", duration: 1 },
      { id: "a", duration: 1 },
      { id: "end", duration: 1, dependsOn: ["z", "a"] },
    ],
  });

  const result = run("plan", input);
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(new TextDecoder().decode(result.stdout)).criticalPath).toEqual(["a", "end"]);
});

test("reports a deterministic concrete dependency cycle", () => {
  const input = writeInput({
    tasks: [
      { id: "b", duration: 1, dependsOn: ["a"] },
      { id: "a", duration: 1, dependsOn: ["b"] },
    ],
  });

  const result = run("plan", input);
  expect(result.exitCode).not.toBe(0);
  expect(new TextDecoder().decode(result.stderr)).toContain("a -> b -> a");
});
