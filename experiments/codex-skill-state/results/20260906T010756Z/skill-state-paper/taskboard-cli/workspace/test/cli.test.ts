import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const project = join(import.meta.dir, "..");
const directories: string[] = [];

function temporaryDatabase(): string {
  const directory = mkdtempSync(join(tmpdir(), "taskboard-test-"));
  directories.push(directory);
  return join(directory, "tasks.json");
}

function run(database: string, ...args: string[]) {
  const result = Bun.spawnSync(["bun", "run", "src/cli.ts", ...args], {
    cwd: project,
    env: { ...process.env, TASKBOARD_FILE: database },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = result.stdout.toString().trim();
  return {
    exitCode: result.exitCode,
    stdout,
    stderr: result.stderr.toString().trim(),
    json: JSON.parse(stdout),
  };
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});

describe("taskboard CLI", () => {
  test("persists tasks, normalizes tags, filters, and keeps ids monotonic", () => {
    const database = temporaryDatabase();
    const first = run(database, "add", "--title", "Write tests", "--tags", " Work,work, CLI ", "--due", "2020-01-01");
    expect(first.exitCode).toBe(0);
    expect(first.json).toMatchObject({ id: 1, status: "open", tags: ["work", "cli"], due: "2020-01-01" });
    expect(run(database, "add", "--title", "Ship", "--tags", "release").json.id).toBe(2);
    expect(run(database, "list", "--status", "open", "--tag", "WORK").json.map((task: { id: number }) => task.id)).toEqual([1]);
    expect(run(database, "list", "--overdue", "2020-01-02").json.map((task: { id: number }) => task.id)).toEqual([1]);

    const done = run(database, "done", "1");
    expect(done.json.status).toBe("done");
    const completedAt = done.json.completedAt;
    expect(run(database, "done", "1").json.completedAt).toBe(completedAt);
    expect(run(database, "stats").json).toEqual({ total: 2, open: 1, done: 1, overdue: 0 });
    expect(run(database, "delete", "2").json.id).toBe(2);
    expect(run(database, "add", "--title", "Next").json.id).toBe(3);
  });

  test("rejects invalid input with one JSON stdout value and preserves malformed data", () => {
    const database = temporaryDatabase();
    const badDate = run(database, "add", "--title", "Bad", "--due", "2023-02-29");
    expect(badDate.exitCode).not.toBe(0);
    expect(badDate.json.error).toContain("valid YYYY-MM-DD");
    expect(badDate.stderr).not.toBe("");

    writeFileSync(database, "not json\n");
    const malformed = run(database, "add", "--title", "Must not overwrite");
    expect(malformed.exitCode).not.toBe(0);
    expect(malformed.json.error).toContain("malformed database");
    expect(readFileSync(database, "utf8")).toBe("not json\n");
  });

  test("rejects unknown flags, missing tasks, and invalid commands", () => {
    const database = temporaryDatabase();
    for (const args of [
      ["add", "--title", "A", "--wat", "x"],
      ["done", "99"],
      ["nonsense"],
    ]) {
      const result = run(database, ...args);
      expect(result.exitCode).not.toBe(0);
      expect(typeof result.json.error).toBe("string");
    }
  });
});
