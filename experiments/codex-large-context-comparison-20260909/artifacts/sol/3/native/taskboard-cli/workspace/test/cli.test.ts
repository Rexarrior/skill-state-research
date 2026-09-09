import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const cli = join(import.meta.dir, "..", "src", "cli.ts");
const temporaryDirectories: string[] = [];

async function makeDatabasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "taskboard-test-"));
  temporaryDirectories.push(directory);
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
  return { exitCode, stdout, stderr, value: JSON.parse(stdout) };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("taskboard CLI", () => {
  test("adds normalized tasks and persists monotonic ids", async () => {
    const database = await makeDatabasePath();
    const first = await invoke(
      database,
      "add",
      "--title",
      "  Ship it  ",
      "--tags",
      "Work, work, Urgent",
      "--due",
      "2028-02-29",
    );
    expect(first.exitCode).toBe(0);
    expect(first.value).toMatchObject({
      id: 1,
      title: "Ship it",
      status: "open",
      tags: ["work", "urgent"],
      due: "2028-02-29",
    });

    expect((await invoke(database, "delete", "1")).value).toEqual({ deleted: 1 });
    expect((await invoke(database, "add", "--title", "Next")).value.id).toBe(2);
    expect(JSON.parse(await readFile(database, "utf8")).nextId).toBe(3);
  });

  test("lists with combined filters in id order", async () => {
    const database = await makeDatabasePath();
    await invoke(database, "add", "--title", "Old", "--tags", "Home", "--due", "2020-01-01");
    await invoke(database, "add", "--title", "New", "--tags", "home", "--due", "2099-01-01");
    await invoke(database, "add", "--title", "Other", "--due", "2019-01-01");
    await invoke(database, "done", "3");

    const result = await invoke(database, "list", "--tag", " HOME ", "--status", "open", "--overdue", "2021-01-01");
    expect(result.value.map((task: { id: number }) => task.id)).toEqual([1]);
  });

  test("done is idempotent and stats count only open overdue tasks", async () => {
    const database = await makeDatabasePath();
    await invoke(database, "add", "--title", "Late", "--due", "2000-01-01");
    await invoke(database, "add", "--title", "Also late", "--due", "2000-01-01");
    const first = await invoke(database, "done", "2");
    const second = await invoke(database, "done", "2");
    expect(second.value.completedAt).toBe(first.value.completedAt);
    expect((await invoke(database, "stats")).value).toEqual({ total: 2, open: 1, done: 1, overdue: 1 });
  });

  test("rejects invalid input with one JSON stdout value", async () => {
    const database = await makeDatabasePath();
    const result = await invoke(database, "add", "--title", "x", "--due", "2023-02-29");
    expect(result.exitCode).not.toBe(0);
    expect(result.value.error).toContain("valid date");
    expect(result.stderr).toContain("valid date");
    expect(result.stdout.trim().split("\n")).toHaveLength(1);

    const century = await invoke(database, "add", "--title", "x", "--due", "2100-02-29");
    expect(century.exitCode).not.toBe(0);
  });

  test("does not replace a malformed database", async () => {
    const database = await makeDatabasePath();
    await writeFile(database, "this is not json\n");
    const result = await invoke(database, "add", "--title", "Do not write");
    expect(result.exitCode).not.toBe(0);
    expect(await readFile(database, "utf8")).toBe("this is not json\n");
  });
});
