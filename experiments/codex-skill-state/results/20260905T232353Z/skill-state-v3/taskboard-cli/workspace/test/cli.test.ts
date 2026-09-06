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

async function run(database: string, ...args: string[]) {
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
  const lines = stdout.trimEnd().split("\n");
  return { value: JSON.parse(stdout), stdout, stderr, exitCode, lines };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("taskboard CLI", () => {
  test("persists tasks across processes, normalizes tags, and never reuses ids", async () => {
    const { database } = await workspace();
    const first = await run(database, "add", "--title", " First task ", "--tags", "Work, work, HOME", "--due", "2024-01-01");
    expect(first.exitCode).toBe(0);
    expect(first.value).toMatchObject({ id: 1, title: "First task", status: "open", tags: ["work", "home"], due: "2024-01-01" });
    expect(first.lines).toHaveLength(1);

    await run(database, "add", "--title", "Second", "--tags", "home");
    expect((await run(database, "list", "--status", "open", "--tag", "HOME")).value.map((task: { id: number }) => task.id)).toEqual([1, 2]);
    expect((await run(database, "list", "--overdue", "2024-01-02")).value.map((task: { id: number }) => task.id)).toEqual([1]);

    const done = await run(database, "done", "1");
    const completedAt = done.value.completedAt;
    expect(done.value.status).toBe("done");
    expect((await run(database, "done", "1")).value.completedAt).toBe(completedAt);
    expect((await run(database, "delete", "2")).value.id).toBe(2);
    expect((await run(database, "add", "--title", "Third")).value.id).toBe(3);
  });

  test("computes stats and combines filters", async () => {
    const { database } = await workspace();
    await run(database, "add", "--title", "Old", "--tags", "x", "--due", "2000-01-01");
    await run(database, "add", "--title", "Future", "--tags", "x", "--due", "2999-01-01");
    await run(database, "add", "--title", "Done old", "--tags", "x", "--due", "2000-01-01");
    await run(database, "done", "3");
    expect((await run(database, "stats")).value).toEqual({ total: 3, open: 2, done: 1, overdue: 1 });
    expect((await run(database, "list", "--status", "open", "--tag", "x", "--overdue", "2100-01-01")).value.map((task: { id: number }) => task.id)).toEqual([1]);
  });

  test("rejects bad input with one JSON value and preserves malformed data", async () => {
    const { database } = await workspace();
    for (const args of [
      ["add", "--title", ""],
      ["add", "--title", "bad date", "--due", "2023-02-29"],
      ["list", "--wat", "x"],
      ["done", "99"],
      ["mystery"],
    ]) {
      const result = await run(database, ...args);
      expect(result.exitCode).not.toBe(0);
      expect(result.lines).toHaveLength(1);
      expect(result.value.error).toBeString();
      expect(result.stderr).not.toBeEmpty();
    }

    const malformed = "{ definitely not json\n";
    await writeFile(database, malformed);
    const result = await run(database, "add", "--title", "Must not overwrite");
    expect(result.exitCode).not.toBe(0);
    expect(await readFile(database, "utf8")).toBe(malformed);
  });
});
