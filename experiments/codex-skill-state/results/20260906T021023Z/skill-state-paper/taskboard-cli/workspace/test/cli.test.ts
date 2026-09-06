import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function run(...args: string[]) {
  const directory = await mkdtemp(join(tmpdir(), "taskboard-test-"));
  directories.push(directory);
  const file = join(directory, "board.json");
  const process = Bun.spawn(["bun", "run", join(import.meta.dir, "../src/cli.ts"), ...args], {
    cwd: directory,
    env: { ...Bun.env, TASKBOARD_FILE: file },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  return { directory, file, stdout, stderr, exitCode, value: JSON.parse(stdout) };
}

async function runIn(file: string, directory: string, ...args: string[]) {
  const process = Bun.spawn(["bun", "run", join(import.meta.dir, "../src/cli.ts"), ...args], {
    cwd: directory,
    env: { ...Bun.env, TASKBOARD_FILE: file },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
  return { stdout, stderr, exitCode, value: JSON.parse(stdout) };
}

describe("taskboard CLI", () => {
  test("persists tasks, normalizes tags, filters, and preserves IDs", async () => {
    const first = await run("add", "--title", " First task ", "--tags", "Work, work, HOME", "--due", "2024-01-01");
    expect(first.exitCode).toBe(0);
    expect(first.value).toMatchObject({ id: 1, title: "First task", status: "open", tags: ["work", "home"], due: "2024-01-01" });

    const second = await runIn(first.file, first.directory, "add", "--title", "Second");
    expect(second.value.id).toBe(2);
    const done = await runIn(first.file, first.directory, "done", "1");
    expect(done.value.status).toBe("done");
    const completedAt = done.value.completedAt;
    const repeated = await runIn(first.file, first.directory, "done", "1");
    expect(repeated.value.completedAt).toBe(completedAt);

    const list = await runIn(first.file, first.directory, "list", "--status", "done", "--tag", "WORK");
    expect(list.value.map((task: { id: number }) => task.id)).toEqual([1]);
    const removed = await runIn(first.file, first.directory, "delete", "1");
    expect(removed.value).toEqual({ deleted: 1 });
    const third = await runIn(first.file, first.directory, "add", "--title", "Third");
    expect(third.value.id).toBe(3);
  });

  test("applies strict overdue semantics and reports stats", async () => {
    const first = await run("add", "--title", "Old", "--due", "2000-01-01");
    await runIn(first.file, first.directory, "add", "--title", "Boundary", "--due", "2001-01-01");
    await runIn(first.file, first.directory, "add", "--title", "No due");
    const overdue = await runIn(first.file, first.directory, "list", "--overdue", "2001-01-01");
    expect(overdue.value.map((task: { id: number }) => task.id)).toEqual([1]);
    const stats = await runIn(first.file, first.directory, "stats");
    expect(stats.value).toEqual({ total: 3, open: 3, done: 0, overdue: 2 });
  });

  test("rejects invalid input with one JSON stdout value", async () => {
    const invalidDate = await run("add", "--title", "Bad", "--due", "2023-02-29");
    expect(invalidDate.exitCode).not.toBe(0);
    expect(invalidDate.value.error).toContain("valid date");
    expect(invalidDate.stdout.trim().split("\n")).toHaveLength(1);
    expect(invalidDate.stderr).not.toBe("");
  });

  test("does not replace a malformed database", async () => {
    const directory = await mkdtemp(join(tmpdir(), "taskboard-test-"));
    directories.push(directory);
    const file = join(directory, "board.json");
    await writeFile(file, "not json");
    const result = await runIn(file, directory, "add", "--title", "Never written");
    expect(result.exitCode).not.toBe(0);
    expect(await readFile(file, "utf8")).toBe("not json");
  });
});
