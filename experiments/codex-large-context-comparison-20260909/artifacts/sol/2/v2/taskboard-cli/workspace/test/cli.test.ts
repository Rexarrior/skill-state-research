import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const cli = join(import.meta.dir, "..", "src", "cli.ts");
const directories: string[] = [];

async function invoke(directory: string, ...args: string[]) {
  const process = Bun.spawn(["bun", "run", cli, ...args], {
    cwd: directory,
    env: { ...Bun.env, TASKBOARD_FILE: join(directory, "tasks.json") },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  const lines = stdout.trim().split("\n");
  expect(lines).toHaveLength(1);
  return { value: JSON.parse(lines[0]), stderr, exitCode };
}

async function workspace() {
  const directory = await mkdtemp(join(tmpdir(), "taskboard-test-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("taskboard CLI", () => {
  test("adds, normalizes, persists, lists, completes, and deletes tasks", async () => {
    const directory = await workspace();
    const first = await invoke(directory, "add", "--title", " First task ", "--tags", " Work,work, HOME ", "--due", "2020-01-02");
    expect(first.exitCode).toBe(0);
    expect(first.value).toMatchObject({ id: 1, title: "First task", status: "open", tags: ["work", "home"], due: "2020-01-02" });

    const second = await invoke(directory, "add", "--title", "Second");
    expect(second.value.id).toBe(2);
    const tagged = await invoke(directory, "list", "--status", "open", "--tag", "WORK", "--overdue", "2020-01-03");
    expect(tagged.value.map((task: { id: number }) => task.id)).toEqual([1]);

    const completed = await invoke(directory, "done", "1");
    expect(completed.value.status).toBe("done");
    expect(completed.value.completedAt).toBeString();
    const repeated = await invoke(directory, "done", "1");
    expect(repeated.value.completedAt).toBe(completed.value.completedAt);

    const deleted = await invoke(directory, "delete", "2");
    expect(deleted.value.id).toBe(2);
    const third = await invoke(directory, "add", "--title", "Third");
    expect(third.value.id).toBe(3);
    expect((await invoke(directory, "list")).value.map((task: { id: number }) => task.id)).toEqual([1, 3]);
  });

  test("reports stats including only overdue open tasks", async () => {
    const directory = await workspace();
    await invoke(directory, "add", "--title", "Old", "--due", "2000-01-01");
    await invoke(directory, "add", "--title", "Done old", "--due", "2000-01-01");
    await invoke(directory, "done", "2");
    expect((await invoke(directory, "stats")).value).toEqual({ total: 2, open: 1, done: 1, overdue: 1 });
  });

  test("rejects bad input and preserves malformed databases", async () => {
    const directory = await workspace();
    for (const args of [
      ["add", "--title", ""],
      ["add", "--title", "x", "--due", "2023-02-29"],
      ["list", "--wat", "x"],
      ["done", "99"],
      ["nonsense"],
    ]) {
      const result = await invoke(directory, ...args);
      expect(result.exitCode).not.toBe(0);
      expect(result.value.error).toBeString();
      expect(result.stderr).not.toBe("");
    }

    const path = join(directory, "tasks.json");
    await writeFile(path, "not json\n");
    const result = await invoke(directory, "add", "--title", "Must not overwrite");
    expect(result.exitCode).not.toBe(0);
    expect(await readFile(path, "utf8")).toBe("not json\n");
  });
});
