import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const cli = join(import.meta.dir, "..", "src", "cli.ts");
const directories: string[] = [];

async function makeDatabasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "taskboard-test-"));
  directories.push(directory);
  return join(directory, "board.json");
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
  return { value: JSON.parse(lines[0]), stdout, stderr, exitCode, lines };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("taskboard CLI", () => {
  test("persists tasks, normalizes tags, and keeps ids stable", async () => {
    const database = await makeDatabasePath();
    const first = await invoke(
      database,
      "add",
      "--title",
      "  First task  ",
      "--tags",
      "Work, urgent,WORK",
      "--due",
      "2024-02-29",
    );
    expect(first.exitCode).toBe(0);
    expect(first.lines).toHaveLength(1);
    expect(first.value).toMatchObject({
      id: 1,
      title: "First task",
      status: "open",
      tags: ["work", "urgent"],
      due: "2024-02-29",
    });

    await invoke(database, "delete", "1");
    const second = await invoke(database, "add", "--title", "Second");
    expect(second.value.id).toBe(2);
    expect((await invoke(database, "list")).value.map((task: { id: number }) => task.id)).toEqual([2]);
  });

  test("combines list filters and done is idempotent", async () => {
    const database = await makeDatabasePath();
    await invoke(database, "add", "--title", "Old", "--tags", "Ops", "--due", "2020-01-01");
    await invoke(database, "add", "--title", "New", "--tags", "ops", "--due", "2999-01-01");

    const filtered = await invoke(database, "list", "--tag", "OPS", "--overdue", "2021-01-01");
    expect(filtered.value.map((task: { id: number }) => task.id)).toEqual([1]);

    const firstDone = await invoke(database, "done", "1");
    const secondDone = await invoke(database, "done", "1");
    expect(firstDone.value.completedAt).toBe(secondDone.value.completedAt);
    expect((await invoke(database, "list", "--overdue", "2021-01-01")).value).toEqual([]);
    expect((await invoke(database, "stats")).value).toEqual({ total: 2, open: 1, done: 1, overdue: 0 });
  });

  test("rejects bad input with one JSON output", async () => {
    const database = await makeDatabasePath();
    for (const args of [
      ["add", "--title", "   "],
      ["add", "--title", "Bad date", "--due", "2023-02-29"],
      ["list", "--unknown", "x"],
      ["no-such-command"],
      ["done", "1"],
    ]) {
      const result = await invoke(database, ...args);
      expect(result.exitCode).not.toBe(0);
      expect(result.lines).toHaveLength(1);
      expect(result.value.error).toBeString();
      expect(result.stderr).not.toBe("");
    }
  });

  test("does not replace a malformed database", async () => {
    const database = await makeDatabasePath();
    const malformed = "{ definitely not json\n";
    await writeFile(database, malformed);

    const result = await invoke(database, "add", "--title", "Must not be written");
    expect(result.exitCode).not.toBe(0);
    expect(await readFile(database, "utf8")).toBe(malformed);
  });
});
