import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const cli = resolve(import.meta.dir, "../src/cli.ts");
let directory: string;
let database: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "taskboard-test-"));
  database = join(directory, "tasks.json");
});

afterEach(() => rmSync(directory, { recursive: true, force: true }));

function invoke(...args: string[]) {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "run", cli, ...args],
    cwd: directory,
    env: { ...process.env, TASKBOARD_FILE: database },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = result.stdout.toString();
  return {
    exitCode: result.exitCode,
    stdout,
    stderr: result.stderr.toString(),
    value: JSON.parse(stdout),
    lines: stdout.trimEnd().split("\n").length,
  };
}

describe("taskboard CLI", () => {
  test("persists tasks across processes and normalizes tags", () => {
    const added = invoke("add", "--title", "  Ship it  ", "--tags", " Work,work, Urgent ", "--due", "2099-01-02");
    expect(added.exitCode).toBe(0);
    expect(added.lines).toBe(1);
    expect(added.value).toMatchObject({ id: 1, title: "Ship it", status: "open", tags: ["work", "urgent"], due: "2099-01-02" });

    const listed = invoke("list", "--status", "open", "--tag", "WORK");
    expect(listed.value).toHaveLength(1);
    expect(listed.value[0].id).toBe(1);

    const next = invoke("add", "--title", "Second");
    expect(next.value.id).toBe(2);
  });

  test("combines list filters and uses strict overdue comparison", () => {
    invoke("add", "--title", "Old", "--tags", "x", "--due", "2024-01-01");
    invoke("add", "--title", "Boundary", "--tags", "x", "--due", "2024-01-02");
    invoke("add", "--title", "Other", "--tags", "y", "--due", "2023-01-01");
    invoke("done", "3");
    const result = invoke("list", "--status", "open", "--tag", "x", "--overdue", "2024-01-02");
    expect(result.value.map((task: { id: number }) => task.id)).toEqual([1]);
  });

  test("done is idempotent, delete persists, and ids are not reused", () => {
    invoke("add", "--title", "First");
    const firstDone = invoke("done", "1").value;
    const secondDone = invoke("done", "1").value;
    expect(secondDone.completedAt).toBe(firstDone.completedAt);
    expect(invoke("stats").value).toMatchObject({ total: 1, open: 0, done: 1, overdue: 0 });
    expect(invoke("delete", "1").value.id).toBe(1);
    expect(invoke("add", "--title", "Later").value.id).toBe(2);
  });

  test("rejects impossible dates, unknown flags, and missing tasks", () => {
    for (const args of [
      ["add", "--title", "Bad date", "--due", "2023-02-29"],
      ["list", "--wat", "x"],
      ["done", "7"],
    ]) {
      const result = invoke(...args);
      expect(result.exitCode).not.toBe(0);
      expect(result.lines).toBe(1);
      expect(result.value.error).toBeString();
      expect(result.stderr).not.toBe("");
    }
  });

  test("does not replace a malformed database", () => {
    writeFileSync(database, "not json\n");
    const result = invoke("add", "--title", "Nope");
    expect(result.exitCode).not.toBe(0);
    expect(readFileSync(database, "utf8")).toBe("not json\n");
  });
});
