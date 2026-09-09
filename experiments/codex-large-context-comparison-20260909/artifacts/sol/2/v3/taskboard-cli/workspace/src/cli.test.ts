import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const cli = join(import.meta.dir, "cli.ts");
const directories: string[] = [];

async function temporaryDatabase(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "taskboard-test-"));
  directories.push(directory);
  return join(directory, "tasks.json");
}

async function invoke(database: string, ...args: string[]) {
  const process = Bun.spawn(["bun", "run", cli, ...args], {
    env: { ...Bun.env, TASKBOARD_FILE: database },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  const lines = stdout.trim().split("\n");
  return { exitCode, stdout, stderr, value: JSON.parse(lines[0]), lines };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("taskboard CLI", () => {
  test("persists tasks across processes, normalizes tags, filters, and keeps ids stable", async () => {
    const database = await temporaryDatabase();
    const first = await invoke(
      database,
      "add",
      "--title",
      "  Ship release  ",
      "--tags",
      "Work, urgent,WORK",
      "--due",
      "2024-01-01",
    );
    expect(first.exitCode).toBe(0);
    expect(first.lines).toHaveLength(1);
    expect(first.value).toMatchObject({
      id: 1,
      title: "Ship release",
      status: "open",
      tags: ["work", "urgent"],
      due: "2024-01-01",
    });

    const second = await invoke(database, "add", "--title", "Later", "--tags", "home");
    expect(second.value.id).toBe(2);
    const filtered = await invoke(database, "list", "--status", "open", "--tag", " WORK ");
    expect(filtered.value.map((task: { id: number }) => task.id)).toEqual([1]);
    const overdue = await invoke(database, "list", "--overdue", "2024-01-02");
    expect(overdue.value.map((task: { id: number }) => task.id)).toEqual([1]);

    await invoke(database, "delete", "1");
    const third = await invoke(database, "add", "--title", "No ID reuse");
    expect(third.value.id).toBe(3);
  });

  test("done is idempotent and stats count only overdue open tasks", async () => {
    const database = await temporaryDatabase();
    await invoke(database, "add", "--title", "Old", "--due", "2000-01-01");
    await invoke(database, "add", "--title", "Future", "--due", "2999-01-01");
    const completed = await invoke(database, "done", "1");
    const repeated = await invoke(database, "done", "1");
    expect(repeated.value.completedAt).toBe(completed.value.completedAt);
    const stats = await invoke(database, "stats");
    expect(stats.value).toEqual({ total: 2, open: 1, done: 1, overdue: 0 });
  });

  test("errors are non-zero, emit one JSON value, and preserve malformed data", async () => {
    const database = await temporaryDatabase();
    const invalidDate = await invoke(database, "add", "--title", "Bad", "--due", "2023-02-29");
    expect(invalidDate.exitCode).not.toBe(0);
    expect(invalidDate.lines).toHaveLength(1);
    expect(invalidDate.value.error).toContain("valid calendar date");
    expect(invalidDate.stderr).toContain("taskboard:");

    const malformed = "{ definitely not json\n";
    await writeFile(database, malformed);
    const result = await invoke(database, "add", "--title", "Must not overwrite");
    expect(result.exitCode).not.toBe(0);
    expect(await readFile(database, "utf8")).toBe(malformed);
  });

  test("rejects unknown flags, missing tasks, and unexpected arguments", async () => {
    const database = await temporaryDatabase();
    for (const args of [
      ["add", "--title", "x", "--bogus", "y"],
      ["done", "10"],
      ["delete", "1"],
      ["stats", "extra"],
      ["wat"],
    ]) {
      const result = await invoke(database, ...args);
      expect(result.exitCode).not.toBe(0);
      expect(result.lines).toHaveLength(1);
      expect(result.value).toHaveProperty("error");
    }
  });
});
