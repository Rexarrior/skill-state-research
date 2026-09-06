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
  return { exitCode, stdout, stderr, value: JSON.parse(stdout) };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("taskboard CLI", () => {
  test("persists tasks, normalizes tags, filters, completes, deletes, and never reuses IDs", async () => {
    const { database } = await workspace();
    const first = await run(database, "add", "--title", "First", "--tags", " Work,work, Urgent ", "--due", "2000-01-01");
    expect(first.exitCode).toBe(0);
    expect(first.value).toMatchObject({ id: 1, title: "First", status: "open", tags: ["work", "urgent"] });

    const second = await run(database, "add", "--title", "Second", "--tags", "home", "--due", "2999-01-01");
    expect(second.value.id).toBe(2);
    expect((await run(database, "list", "--status", "open", "--tag", "WORK")).value.map((task: any) => task.id)).toEqual([1]);
    expect((await run(database, "list", "--overdue", "2001-01-01")).value.map((task: any) => task.id)).toEqual([1]);

    const completed = await run(database, "done", "1");
    const completedAgain = await run(database, "done", "1");
    expect(completed.value.completedAt).toBe(completedAgain.value.completedAt);
    expect((await run(database, "stats")).value).toEqual({ total: 2, open: 1, done: 1, overdue: 0 });

    expect((await run(database, "delete", "2")).value.id).toBe(2);
    expect((await run(database, "add", "--title", "Third")).value.id).toBe(3);
  });

  test("rejects bad input and preserves a malformed database", async () => {
    const { database } = await workspace();
    expect((await run(database, "add", "--title", "", "--due", "2024-02-30")).exitCode).not.toBe(0);
    expect((await run(database, "wat")).exitCode).not.toBe(0);

    const malformed = "{ definitely not JSON";
    await writeFile(database, malformed);
    const result = await run(database, "add", "--title", "Must not overwrite");
    expect(result.exitCode).not.toBe(0);
    expect(result.value.error).toContain("not valid JSON");
    expect(await readFile(database, "utf8")).toBe(malformed);
  });

  test("prints exactly one JSON value on failures", async () => {
    const { database } = await workspace();
    const result = await run(database, "done", "999");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("task not found");
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
    expect(result.value).toEqual({ error: "task not found: 999" });
  });
});
