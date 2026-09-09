import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const cli = join(import.meta.dir, "..", "src", "cli.ts");
const directories: string[] = [];

function workspace(): { directory: string; database: string } {
  const directory = mkdtempSync(join(tmpdir(), "taskboard-test-"));
  directories.push(directory);
  return { directory, database: join(directory, "tasks.json") };
}

function invoke(directory: string, database: string, args: string[]) {
  const result = Bun.spawnSync(["bun", "run", cli, ...args], {
    cwd: directory,
    env: { ...process.env, TASKBOARD_FILE: database },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = result.stdout.toString().trim();
  return { code: result.exitCode, stdout, stderr: result.stderr.toString(), value: JSON.parse(stdout) };
}

afterEach(() => {
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
});

describe("taskboard CLI", () => {
  test("persists tasks, normalizes tags, filters, completes, and keeps IDs stable", () => {
    const { directory, database } = workspace();
    const first = invoke(directory, database, ["add", "--title", " First task ", "--tags", "Work, work, HOME", "--due", "2000-01-02"]);
    expect(first.code).toBe(0);
    expect(first.value).toMatchObject({ id: 1, title: "First task", status: "open", tags: ["work", "home"], due: "2000-01-02" });
    expect(invoke(directory, database, ["add", "--title=Second"]).value.id).toBe(2);
    expect(invoke(directory, database, ["list", "--tag", "WORK", "--status", "open"]).value.map((task: { id: number }) => task.id)).toEqual([1]);
    expect(invoke(directory, database, ["list", "--overdue", "2000-01-03"]).value.map((task: { id: number }) => task.id)).toEqual([1]);

    const done = invoke(directory, database, ["done", "1"]);
    expect(done.value.status).toBe("done");
    const completedAt = done.value.completedAt;
    expect(invoke(directory, database, ["done", "1"]).value.completedAt).toBe(completedAt);
    expect(invoke(directory, database, ["delete", "2"]).value.id).toBe(2);
    expect(invoke(directory, database, ["add", "--title", "Third"]).value.id).toBe(3);
    expect(invoke(directory, database, ["stats"]).value).toEqual({ total: 2, open: 1, done: 1, overdue: 0 });
  });

  test("rejects invalid input and preserves malformed databases", () => {
    const { directory, database } = workspace();
    for (const args of [
      ["add", "--title", "  "],
      ["add", "--title", "x", "--due", "2025-02-29"],
      ["list", "--unknown", "x"],
      ["done", "9"],
      ["unknown"],
    ]) {
      const result = invoke(directory, database, args);
      expect(result.code).not.toBe(0);
      expect(result.value.error).toBeString();
      expect(result.stderr.length).toBeGreaterThan(0);
    }

    const malformed = "{ definitely not json";
    writeFileSync(database, malformed);
    const result = invoke(directory, database, ["add", "--title", "safe"]);
    expect(result.code).not.toBe(0);
    expect(readFileSync(database, "utf8")).toBe(malformed);
  });
});
