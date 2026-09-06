import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const directory = mkdtempSync(join(tmpdir(), "taskboard-test-"));
const database = join(directory, "tasks.json");
const cli = join(import.meta.dir, "..", "src", "cli.ts");

function run(...args: string[]) {
  return Bun.spawnSync(["bun", "run", cli, ...args], { env: { ...process.env, TASKBOARD_FILE: database }, stdout: "pipe", stderr: "pipe" });
}

afterEach(() => rmSync(database, { force: true }));

test("persists, filters, completes, and reports task statistics", () => {
  let result = run("add", "--title", " First task ", "--tags", "Work,work, urgent ", "--due", "2020-01-01");
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout.toString())).toMatchObject({ id: 1, title: "First task", tags: ["work", "urgent"], status: "open", due: "2020-01-01" });
  result = run("add", "--title", "Second");
  expect(JSON.parse(result.stdout.toString())).toMatchObject({ id: 2, status: "open" });
  result = run("list", "--tag", "WORK", "--overdue", "2021-01-01");
  expect(JSON.parse(result.stdout.toString())).toHaveLength(1);
  result = run("done", "1");
  expect(JSON.parse(result.stdout.toString())).toMatchObject({ status: "done" });
  result = run("done", "1");
  expect(result.exitCode).toBe(0);
  result = run("stats");
  expect(JSON.parse(result.stdout.toString())).toEqual({ total: 2, open: 1, done: 1, overdue: 0 });
});

test("rejects invalid input without creating data", () => {
  const result = run("add", "--title", "", "--due", "2024-02-30");
  expect(result.exitCode).not.toBe(0);
  expect(result.stdout.toString()).toBe("");
  expect(Bun.file(database).size).toBe(0);
});
