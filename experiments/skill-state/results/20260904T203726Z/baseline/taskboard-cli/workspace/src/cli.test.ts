import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directories: string[] = [];

function invoke(...args: string[]) {
  const directory = mkdtempSync(join(tmpdir(), "taskboard-"));
  directories.push(directory);
  const result = Bun.spawnSync(["bun", "run", "src/cli.ts", ...args], {
    cwd: import.meta.dir + "/..",
    env: { ...process.env, TASKBOARD_FILE: join(directory, "tasks.json") },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: result.exitCode, output: JSON.parse(result.stdout.toString()), error: result.stderr.toString() };
}

afterEach(() => {
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
});

describe("taskboard CLI", () => {
  test("persists, filters, completes, and deletes tasks", () => {
    const directory = mkdtempSync(join(tmpdir(), "taskboard-"));
    directories.push(directory);
    const environment = { ...process.env, TASKBOARD_FILE: join(directory, "tasks.json") };
    const command = (...args: string[]) => Bun.spawnSync(["bun", "run", "src/cli.ts", ...args], { cwd: import.meta.dir + "/..", env: environment, stdout: "pipe" });
    expect(JSON.parse(command("add", "--title", " First ", "--tags", "Work,work, Urgent", "--due", "2026-01-01").stdout.toString())).toMatchObject({ id: 1, title: "First", tags: ["work", "urgent"], status: "open" });
    expect(JSON.parse(command("add", "--title", "Second").stdout.toString())).toMatchObject({ id: 2 });
    expect(JSON.parse(command("list", "--tag", "URGENT", "--overdue", "2026-02-01").stdout.toString())).toHaveLength(1);
    expect(JSON.parse(command("done", "1").stdout.toString())).toMatchObject({ status: "done" });
    expect(JSON.parse(command("done", "1").stdout.toString())).toMatchObject({ status: "done" });
    expect(JSON.parse(command("stats").stdout.toString())).toEqual({ total: 2, open: 1, done: 1, overdue: 0 });
    expect(JSON.parse(command("delete", "2").stdout.toString())).toMatchObject({ id: 2 });
  });

  test("rejects invalid input without creating a database", () => {
    const result = invoke("add", "--title", " ", "--due", "2026-02-30");
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toEqual({ error: "Title cannot be empty" });
    expect(result.error).toContain("Title cannot be empty");
  });
});
