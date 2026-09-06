import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const directory = mkdtempSync(join(tmpdir(), "taskboard-"));
const database = join(directory, "tasks.json");

function run(...args: string[]) {
  return Bun.spawnSync(["bun", "run", "src/cli.ts", ...args], { cwd: process.cwd(), env: { ...process.env, TASKBOARD_FILE: database } });
}
function output(result: ReturnType<typeof run>) { return JSON.parse(result.stdout.toString()); }

afterEach(() => rmSync(database, { force: true }));

test("persists, filters, completes, and reports stats", () => {
  const first = output(run("add", "--title", "First", "--tags", "Work,work, urgent", "--due", "2020-01-01"));
  const second = output(run("add", "--title", "Second", "--tags", "home"));
  expect(first).toMatchObject({ id: 1, status: "open", tags: ["work", "urgent"], due: "2020-01-01" });
  expect(second.id).toBe(2);
  expect(output(run("list", "--tag", "WORK"))).toHaveLength(1);
  expect(output(run("list", "--overdue", "2021-01-01"))).toHaveLength(1);
  expect(output(run("done", "1"))).toMatchObject({ status: "done" });
  expect(output(run("done", "1"))).toMatchObject({ status: "done" });
  expect(output(run("stats"))).toMatchObject({ total: 2, open: 1, done: 1, overdue: 0 });
});

test("rejects invalid input without overwriting data", () => {
  run("add", "--title", "Safe");
  const result = run("add", "--title", "", "--due", "2026-02-30");
  expect(result.exitCode).not.toBe(0);
  expect(output(run("list"))).toHaveLength(1);
});
