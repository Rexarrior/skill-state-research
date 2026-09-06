import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const cli = join(import.meta.dir, "..", "src", "cli.ts");
const directories: string[] = [];

async function workspace(): Promise<{ directory: string; database: string }> {
  const directory = await mkdtemp(join(tmpdir(), "taskboard-test-"));
  directories.push(directory);
  return { directory, database: join(directory, "board.json") };
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
  return { stdout, stderr, exitCode, value: JSON.parse(stdout) };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("taskboard CLI", () => {
  test("persists tasks, normalizes tags, filters, and keeps stable IDs", async () => {
    const { database } = await workspace();
    const first = await invoke(database, "add", "--title", " First task ", "--tags", " Work,work, Urgent ", "--due", "2024-01-31");
    expect(first.exitCode).toBe(0);
    expect(first.value).toMatchObject({ id: 1, title: "First task", status: "open", tags: ["work", "urgent"], due: "2024-01-31" });

    const second = await invoke(database, "add", "--title", "Second");
    expect(second.value.id).toBe(2);
    expect((await invoke(database, "list", "--status", "open", "--tag", "WORK")).value).toHaveLength(1);
    expect((await invoke(database, "list", "--overdue", "2024-02-01")).value.map((task: { id: number }) => task.id)).toEqual([1]);

    await invoke(database, "delete", "1");
    expect((await invoke(database, "add", "--title", "Third")).value.id).toBe(3);
    expect((await invoke(database, "list")).value.map((task: { id: number }) => task.id)).toEqual([2, 3]);
  });

  test("done is idempotent and stats are accurate", async () => {
    const { database } = await workspace();
    await invoke(database, "add", "--title", "Old", "--due", "2000-01-01");
    const completed = await invoke(database, "done", "1");
    const repeated = await invoke(database, "done", "1");
    expect(repeated.value.completedAt).toBe(completed.value.completedAt);
    expect((await invoke(database, "stats")).value).toEqual({ total: 1, open: 0, done: 1, overdue: 0 });
  });

  test("rejects invalid input and preserves malformed databases", async () => {
    const { database } = await workspace();
    for (const args of [
      ["add", "--title", "  "],
      ["add", "--title", "Bad date", "--due", "2023-02-29"],
      ["list", "--wat", "x"],
      ["done", "99"],
      ["unknown"],
    ]) {
      const result = await invoke(database, ...args);
      expect(result.exitCode).not.toBe(0);
      expect(result.value.error).toBeString();
      expect(result.stderr.trim()).not.toBe("");
      expect(result.stdout.trim().split("\n")).toHaveLength(1);
    }

    await writeFile(database, "not-json\n");
    const malformed = await invoke(database, "list");
    expect(malformed.exitCode).not.toBe(0);
    expect(await readFile(database, "utf8")).toBe("not-json\n");
  });
});
