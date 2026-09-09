import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

let directory: string;
let database: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "taskboard-test-"));
  database = join(directory, "tasks.json");
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function cli(...args: string[]) {
  const process = Bun.spawn(["bun", "run", "src/cli.ts", ...args], {
    cwd: join(import.meta.dir, ".."),
    env: { ...Bun.env, TASKBOARD_FILE: database },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  return { stdout, stderr, exitCode, value: stdout ? JSON.parse(stdout) : undefined };
}

describe("taskboard CLI", () => {
  test("adds, persists, normalizes tags, and lists by combined filters", async () => {
    const first = await cli("add", "--title", " First task ", "--tags", "Work, work, HOME", "--due", "2020-01-01");
    expect(first.exitCode).toBe(0);
    expect(first.value).toMatchObject({ id: 1, title: "First task", status: "open", tags: ["work", "home"], due: "2020-01-01" });
    expect(first.value.createdAt).toBeString();

    await cli("add", "--title", "Second task", "--tags", "work", "--due", "2999-01-01");
    const listed = await cli("list", "--status", "open", "--tag", "WORK", "--overdue", "2021-01-01");
    expect(listed.value.map((task: { id: number }) => task.id)).toEqual([1]);
    expect(JSON.parse(await readFile(database, "utf8"))).toMatchObject({ nextId: 3 });
  });

  test("done is idempotent and stats are correct", async () => {
    await cli("add", "--title", "Old", "--due", "2000-01-01");
    await cli("add", "--title", "Future", "--due", "2999-01-01");
    const done = await cli("done", "1");
    const completedAt = done.value.completedAt;
    const repeated = await cli("done", "1");
    expect(repeated.value.completedAt).toBe(completedAt);
    expect((await cli("stats")).value).toEqual({ total: 2, open: 1, done: 1, overdue: 0 });
  });

  test("deletes tasks without reusing IDs", async () => {
    await cli("add", "--title", "One");
    expect((await cli("delete", "1")).value.id).toBe(1);
    expect((await cli("add", "--title", "Two")).value.id).toBe(2);
  });

  test("rejects invalid input and preserves malformed databases", async () => {
    expect((await cli("add", "--title", " ")).exitCode).not.toBe(0);
    expect((await cli("add", "--title", "Bad", "--due", "2023-02-29")).exitCode).not.toBe(0);
    expect((await cli("list", "--wat", "x")).exitCode).not.toBe(0);
    expect((await cli("done", "99")).exitCode).not.toBe(0);
    await writeFile(database, "not json");
    expect((await cli("add", "--title", "Safe")).exitCode).not.toBe(0);
    expect(await readFile(database, "utf8")).toBe("not json");
  });
});
