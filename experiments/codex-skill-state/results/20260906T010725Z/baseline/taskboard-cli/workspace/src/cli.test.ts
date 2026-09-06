import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = join(import.meta.dir, "cli.ts");
const directories: string[] = [];

async function workspace(): Promise<{ directory: string; database: string }> {
  const directory = await mkdtemp(join(tmpdir(), "taskboard-test-"));
  directories.push(directory);
  return { directory, database: join(directory, "tasks.json") };
}

function invoke(directory: string, database: string, args: string[]) {
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
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("taskboard CLI", () => {
  test("persists normalized tasks and combines list filters", async () => {
    const { directory, database } = await workspace();
    const first = invoke(directory, database, [
      "add", "--title", " First task ", "--tags", "Work, work, Urgent", "--due", "2020-01-01",
    ]);
    const second = invoke(directory, database, ["add", "--title", "Second", "--tags", "home"]);

    expect(first.exitCode).toBe(0);
    expect(first.json).toMatchObject({ id: 1, title: "First task", status: "open", tags: ["work", "urgent"] });
    expect(second.json.id).toBe(2);
    expect(invoke(directory, database, ["list", "--tag", "WORK", "--overdue", "2021-01-01"]).json)
      .toEqual([first.json]);
  });

  test("done is idempotent and stats only count overdue open tasks", async () => {
    const { directory, database } = await workspace();
    invoke(directory, database, ["add", "--title", "Old", "--due", "2000-01-01"]);
    invoke(directory, database, ["add", "--title", "Current"]);
    const completed = invoke(directory, database, ["done", "1"]).json;
    const repeated = invoke(directory, database, ["done", "1"]).json;

    expect(repeated.completedAt).toBe(completed.completedAt);
    expect(invoke(directory, database, ["stats"]).json).toEqual({ total: 2, open: 1, done: 1, overdue: 0 });
  });

  test("delete does not reuse ids", async () => {
    const { directory, database } = await workspace();
    invoke(directory, database, ["add", "--title", "One"]);
    expect(invoke(directory, database, ["delete", "1"]).json.id).toBe(1);
    expect(invoke(directory, database, ["add", "--title", "Two"]).json.id).toBe(2);
  });

  test("rejects invalid input with one JSON stdout value", async () => {
    const { directory, database } = await workspace();
    const invalid = invoke(directory, database, ["add", "--title", " ", "--wat", "x"]);
    expect(invalid.exitCode).not.toBe(0);
    expect(invalid.json).toHaveProperty("error");
    expect(invalid.stdout.trim().split("\n")).toHaveLength(1);
    expect(invalid.stderr.length).toBeGreaterThan(0);

    const impossibleDate = invoke(directory, database, [
      "add", "--title", "Bad date", "--due", "2025-02-29",
    ]);
    expect(impossibleDate.exitCode).not.toBe(0);
    expect(impossibleDate.json.error).toContain("valid YYYY-MM-DD");
  });

  test("rejects malformed storage without replacing it", async () => {
    const { directory, database } = await workspace();
    await writeFile(database, "not json\n");
    const result = invoke(directory, database, ["list"]);
    expect(result.exitCode).not.toBe(0);
    expect(await readFile(database, "utf8")).toBe("not json\n");
  });
});
