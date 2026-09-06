import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const cli = resolve(import.meta.dir, "../src/cli.ts");
let directory: string;
let database: string;

beforeEach(() => {
  directory = mkdtempSync(join(process.cwd(), ".taskboard-test-"));
  database = join(directory, "tasks.json");
});

afterEach(() => rmSync(directory, { recursive: true, force: true }));

function invoke(...args: string[]) {
  const result = Bun.spawnSync([process.execPath, "run", cli, ...args], {
    cwd: directory,
    env: { PATH: process.env.PATH ?? "", TASKBOARD_FILE: database },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = result.stdout.toString();
  return {
    exitCode: result.exitCode,
    stdout,
    stderr: result.stderr.toString(),
    value: JSON.parse(stdout),
  };
}

describe("taskboard CLI", () => {
  test("persists tasks across processes and normalizes tags", () => {
    const added = invoke("add", "--title", " First task ", "--tags", "Work, work, Urgent", "--due", "2099-12-31");
    expect(added.exitCode).toBe(0);
    expect(added.value).toMatchObject({ id: 1, title: "First task", status: "open", tags: ["work", "urgent"] });

    expect(invoke("list", "--tag", "WORK").value).toEqual([added.value]);
    expect(invoke("add", "--title", "Second").value.id).toBe(2);
    expect(invoke("list").value.map((task: { id: number }) => task.id)).toEqual([1, 2]);
  });

  test("done is idempotent and filters combine", () => {
    invoke("add", "--title", "Old", "--tags", "x", "--due", "2000-01-01");
    invoke("add", "--title", "Future", "--tags", "x", "--due", "2099-01-01");
    const first = invoke("done", "1").value;
    const second = invoke("done", "1").value;
    expect(second.completedAt).toBe(first.completedAt);
    expect(invoke("list", "--status", "open", "--tag", "x", "--overdue", "2100-01-01").value).toHaveLength(1);
  });

  test("delete does not recycle IDs", () => {
    invoke("add", "--title", "One");
    expect(invoke("delete", "1").value).toEqual({ deleted: 1 });
    expect(invoke("add", "--title", "Two").value.id).toBe(2);
  });

  test("stats count only open overdue tasks", () => {
    invoke("add", "--title", "Late", "--due", "2000-01-01");
    invoke("add", "--title", "Also late", "--due", "2000-01-01");
    invoke("done", "2");
    expect(invoke("stats").value).toEqual({ total: 2, open: 1, done: 1, overdue: 1 });
  });

  test("invalid input emits one JSON error and preserves malformed data", () => {
    expect(invoke("add", "--title", "x", "--due", "2025-02-29").exitCode).not.toBe(0);
    expect(invoke("list", "--wat", "x").exitCode).not.toBe(0);

    const malformed = "not json\n";
    writeFileSync(database, malformed);
    const result = invoke("add", "--title", "Must not overwrite");
    expect(result.exitCode).not.toBe(0);
    expect(result.value.error).toContain("malformed");
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
    expect(readFileSync(database, "utf8")).toBe(malformed);
  });

  test("empty stores and calendar edge cases are handled strictly", () => {
    expect(invoke("list").value).toEqual([]);
    expect(invoke("stats").value).toEqual({ total: 0, open: 0, done: 0, overdue: 0 });
    expect(invoke("add", "--title", "Leap", "--due", "2024-02-29").exitCode).toBe(0);
    expect(invoke("add", "--title", "Bad", "--due", "1900-02-29").exitCode).not.toBe(0);
    expect(invoke("add", "--title", "Year zero", "--due", "0000-02-29").exitCode).toBe(0);
  });

  test("missing tasks and malformed structures never mutate the database", () => {
    invoke("add", "--title", "Keep me");
    const before = readFileSync(database, "utf8");
    expect(invoke("done", "99").exitCode).not.toBe(0);
    expect(invoke("delete", "99").exitCode).not.toBe(0);
    expect(readFileSync(database, "utf8")).toBe(before);

    writeFileSync(database, JSON.stringify({ version: 1, nextId: 1, tasks: [{ id: 1 }] }));
    expect(invoke("list").exitCode).not.toBe(0);
  });
});
