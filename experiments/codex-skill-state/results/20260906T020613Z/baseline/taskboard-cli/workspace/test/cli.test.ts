import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const cli = join(import.meta.dir, "..", "src", "cli.ts");
const directories: string[] = [];

async function temporaryDatabase(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "taskboard-test-"));
  directories.push(directory);
  return join(directory, "tasks.json");
}

function invoke(database: string, ...args: string[]) {
  const result = Bun.spawnSync([process.execPath, "run", cli, ...args], {
    env: { ...process.env, TASKBOARD_FILE: database },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = result.stdout.toString();
  return {
    exitCode: result.exitCode,
    stdout,
    stderr: result.stderr.toString(),
    json: JSON.parse(stdout),
  };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("taskboard CLI", () => {
  test("persists tasks, normalizes tags, filters, and keeps IDs stable", async () => {
    const database = await temporaryDatabase();
    const first = invoke(database, "add", "--title", " First task ", "--tags", "Work, work, Urgent", "--due", "2024-02-29");
    expect(first.exitCode).toBe(0);
    expect(first.json).toMatchObject({ id: 1, title: " First task ", status: "open", tags: ["work", "urgent"], due: "2024-02-29" });

    expect(invoke(database, "add", "--title=Second", "--tags", "home").json.id).toBe(2);
    expect(invoke(database, "list", "--tag", "WORK").json).toHaveLength(1);
    expect(invoke(database, "list", "--overdue", "2024-03-01").json).toHaveLength(1);
    expect(invoke(database, "delete", "1").exitCode).toBe(0);
    expect(invoke(database, "add", "--title", "Third").json.id).toBe(3);
  });

  test("done is idempotent and stats count only open overdue tasks", async () => {
    const database = await temporaryDatabase();
    invoke(database, "add", "--title", "Old", "--due", "2000-01-01");
    invoke(database, "add", "--title", "Future", "--due", "2999-01-01");
    const completed = invoke(database, "done", "1").json;
    const repeated = invoke(database, "done", "1").json;
    expect(repeated.completedAt).toBe(completed.completedAt);
    expect(invoke(database, "stats").json).toEqual({ total: 2, open: 1, done: 1, overdue: 0 });
    expect(invoke(database, "list", "--status", "done").json).toHaveLength(1);
  });

  test("rejects bad input and preserves a malformed database", async () => {
    const database = await temporaryDatabase();
    expect(invoke(database, "add", "--title", "x", "--due", "2023-02-29").exitCode).toBe(1);
    expect(invoke(database, "add", "--title", " ").exitCode).toBe(1);
    expect(invoke(database, "list", "--wat", "x").exitCode).toBe(1);

    await writeFile(database, "not json\n");
    const result = invoke(database, "add", "--title", "Must not overwrite");
    expect(result.exitCode).toBe(1);
    expect(result.json.error).toContain("Malformed database");
    expect(await readFile(database, "utf8")).toBe("not json\n");
  });

  test("each invocation emits one JSON value and atomic writes leave no temporary files", async () => {
    const database = await temporaryDatabase();
    for (const args of [["stats"], ["unknown"], ["done", "999"]]) {
      const result = invoke(database, ...args);
      expect(result.stdout.trim().split("\n")).toHaveLength(1);
      expect(() => JSON.parse(result.stdout)).not.toThrow();
    }
    expect((await readdir(join(database, ".."))).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });
});
