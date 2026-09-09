import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const cli = join(import.meta.dir, "..", "src", "cli.ts");
const directories: string[] = [];

async function run(args: string[], file: string) {
  const process = Bun.spawn(["bun", "run", cli, ...args], {
    env: { ...Bun.env, TASKBOARD_FILE: file },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  return { stdout, stderr, exitCode };
}

async function freshFile() {
  const directory = await mkdtemp(join(tmpdir(), "taskboard-test-"));
  directories.push(directory);
  return join(directory, "tasks.json");
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("taskboard CLI", () => {
  test("persists tasks, normalizes tags, and keeps ids stable", async () => {
    const file = await freshFile();
    const first = await run(["add", "--title", " First task ", "--tags", "Work, work, HOME", "--due", "2026-01-02"], file);
    expect(first.exitCode).toBe(0);
    expect(JSON.parse(first.stdout)).toMatchObject({ id: 1, title: "First task", status: "open", tags: ["work", "home"], due: "2026-01-02" });
    expect(first.stderr).toBe("");

    expect((await run(["delete", "1"], file)).exitCode).toBe(0);
    const second = await run(["add", "--title", "Second"], file);
    expect(JSON.parse(second.stdout).id).toBe(2);
    expect(JSON.parse((await run(["list"], file)).stdout).map((task: { id: number }) => task.id)).toEqual([2]);
  });

  test("filters with AND semantics and completes idempotently", async () => {
    const file = await freshFile();
    await run(["add", "--title", "Old work", "--tags", "work", "--due", "2020-01-01"], file);
    await run(["add", "--title", "Later work", "--tags", "work", "--due", "2030-01-01"], file);
    await run(["add", "--title", "Old home", "--tags", "home", "--due", "2020-01-01"], file);
    const filtered = await run(["list", "--status", "open", "--tag", "WORK", "--overdue", "2025-01-01"], file);
    expect(JSON.parse(filtered.stdout).map((task: { id: number }) => task.id)).toEqual([1]);

    const done = JSON.parse((await run(["done", "1"], file)).stdout);
    const again = JSON.parse((await run(["done", "1"], file)).stdout);
    expect(again.completedAt).toBe(done.completedAt);
    expect(JSON.parse((await run(["stats"], file)).stdout)).toEqual({ total: 3, open: 2, done: 1, overdue: 1 });
  });

  test("rejects invalid input without replacing malformed data", async () => {
    const file = await freshFile();
    for (const args of [
      ["add", "--title", "   "],
      ["add", "--title", "x", "--due", "2025-02-29"],
      ["add", "--title", "x", "--due", "0000-02-29"],
      ["list", "--wat", "x"],
      ["done", "99"],
      ["unknown"],
    ]) {
      const result = await run(args, file);
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr.length).toBeGreaterThan(0);
    }

    await writeFile(file, "{ definitely broken");
    const malformed = await run(["list"], file);
    expect(malformed.exitCode).not.toBe(0);
    expect(malformed.stdout).toBe("");
    expect(await readFile(file, "utf8")).toBe("{ definitely broken");
  });
});
