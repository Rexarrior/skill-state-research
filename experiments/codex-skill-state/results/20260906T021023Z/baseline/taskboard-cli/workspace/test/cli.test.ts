import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const cli = join(import.meta.dir, "..", "src", "cli.ts");
const directories: string[] = [];

async function workspace(): Promise<{ directory: string; database: string }> {
  const directory = await mkdtemp(join(tmpdir(), "taskboard-test-"));
  directories.push(directory);
  return { directory, database: join(directory, "tasks.json") };
}

function run(directory: string, database: string, args: string[]) {
  const result = Bun.spawnSync([process.execPath, "run", cli, ...args], {
    cwd: directory,
    env: { ...process.env, TASKBOARD_FILE: database },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    json: JSON.parse(result.stdout.toString()),
  };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("taskboard CLI", () => {
  test("persists tasks, normalizes tags, and never reuses ids", async () => {
    const { directory, database } = await workspace();
    const first = run(directory, database, [
      "add", "--title", " First task ", "--tags", "Work, urgent,WORK", "--due", "2099-02-28",
    ]);
    expect(first.exitCode).toBe(0);
    expect(first.json).toMatchObject({ id: 1, title: "First task", status: "open", tags: ["work", "urgent"] });

    expect(run(directory, database, ["delete", "1"]).exitCode).toBe(0);
    const second = run(directory, database, ["add", "--title", "Second"]);
    expect(second.json.id).toBe(2);

    const stored = JSON.parse(await readFile(database, "utf8"));
    expect(stored.nextId).toBe(3);
    expect(stored.tasks).toHaveLength(1);
  });

  test("combines list filters with AND and sorts by id", async () => {
    const { directory, database } = await workspace();
    run(directory, database, ["add", "--title", "Later", "--tags", "Work", "--due", "2099-01-02"]);
    run(directory, database, ["add", "--title", "Early", "--tags", "work", "--due", "2000-01-01"]);
    run(directory, database, ["add", "--title", "Other", "--tags", "home", "--due", "2000-01-01"]);
    run(directory, database, ["done", "3"]);

    const listed = run(directory, database, ["list", "--status", "open", "--tag", "WORK", "--overdue", "2099-01-01"]);
    expect(listed.exitCode).toBe(0);
    expect(listed.json.map((task: { id: number }) => task.id)).toEqual([2]);
  });

  test("done is idempotent and stats count only open overdue tasks", async () => {
    const { directory, database } = await workspace();
    run(directory, database, ["add", "--title", "Old", "--due", "2000-01-01"]);
    run(directory, database, ["add", "--title", "Future", "--due", "2099-01-01"]);

    const completed = run(directory, database, ["done", "1"]);
    const repeated = run(directory, database, ["done", "1"]);
    expect(repeated.json.completedAt).toBe(completed.json.completedAt);
    expect(run(directory, database, ["stats"]).json).toEqual({ total: 2, open: 1, done: 1, overdue: 0 });
  });

  test("rejects invalid input and preserves malformed databases", async () => {
    const { directory, database } = await workspace();
    expect(run(directory, database, ["add", "--title", "x", "--due", "2025-02-29"]).exitCode).not.toBe(0);
    expect(run(directory, database, ["add", "--title", "   "]).exitCode).not.toBe(0);
    expect(run(directory, database, ["wat"]).exitCode).not.toBe(0);

    await writeFile(database, "{ definitely broken", "utf8");
    const result = run(directory, database, ["add", "--title", "Must not overwrite"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("not valid JSON");
    expect(await readFile(database, "utf8")).toBe("{ definitely broken");
  });

  test("prints exactly one JSON value on failures", async () => {
    const { directory, database } = await workspace();
    const result = run(directory, database, ["delete", "99"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.json).toEqual({ error: "task 99 does not exist" });
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
  });
});
