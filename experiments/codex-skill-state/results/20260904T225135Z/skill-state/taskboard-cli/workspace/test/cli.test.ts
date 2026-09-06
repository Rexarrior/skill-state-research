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

async function run(directory: string, database: string, ...args: string[]) {
  const child = Bun.spawn([process.execPath, "run", cli, ...args], {
    cwd: directory,
    env: { ...Bun.env, TASKBOARD_FILE: database },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr, value: JSON.parse(stdout) };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("taskboard CLI", () => {
  test("persists tasks, normalizes tags, and keeps IDs stable", async () => {
    const { directory, database } = await workspace();
    const first = await run(directory, database, "add", "--title", " First task ", "--tags", "Work, work,HOME", "--due", "2099-02-28");
    const second = await run(directory, database, "add", "--title", "Second");
    expect(first.exitCode).toBe(0);
    expect(first.value).toMatchObject({ id: 1, title: "First task", status: "open", tags: ["work", "home"], due: "2099-02-28" });
    expect(second.value.id).toBe(2);
    const listed = await run(directory, database, "list", "--tag", "WORK", "--status", "open");
    expect(listed.value.map((task: { id: number }) => task.id)).toEqual([1]);
  });

  test("done is idempotent and stats count overdue open tasks", async () => {
    const { directory, database } = await workspace();
    await run(directory, database, "add", "--title", "Old", "--due", "2000-01-01");
    await run(directory, database, "add", "--title", "Complete me", "--due", "2000-01-01");
    const done = await run(directory, database, "done", "2");
    const again = await run(directory, database, "done", "2");
    expect(again.value.completedAt).toBe(done.value.completedAt);
    expect((await run(directory, database, "stats")).value).toEqual({ total: 2, open: 1, done: 1, overdue: 1 });
  });

  test("overdue filtering is strict and delete persists", async () => {
    const { directory, database } = await workspace();
    await run(directory, database, "add", "--title", "Earlier", "--due", "2025-01-01");
    await run(directory, database, "add", "--title", "Boundary", "--due", "2025-01-02");
    const result = await run(directory, database, "list", "--overdue", "2025-01-02");
    expect(result.value.map((task: { id: number }) => task.id)).toEqual([1]);
    expect((await run(directory, database, "delete", "1")).value.id).toBe(1);
    expect((await run(directory, database, "list")).value.map((task: { id: number }) => task.id)).toEqual([2]);
  });

  test("rejects invalid input and preserves malformed databases", async () => {
    const { directory, database } = await workspace();
    for (const args of [
      ["add", "--title", ""],
      ["add", "--title", "Bad date", "--due", "2025-02-29"],
      ["list", "--wat", "x"],
      ["done", "99"],
    ]) {
      const result = await run(directory, database, ...args);
      expect(result.exitCode).not.toBe(0);
      expect(result.value.error).toBeString();
      expect(result.stderr).not.toBe("");
    }
    await writeFile(database, "not json\n");
    const result = await run(directory, database, "add", "--title", "Must not overwrite");
    expect(result.exitCode).not.toBe(0);
    expect(await readFile(database, "utf8")).toBe("not json\n");
  });
});
