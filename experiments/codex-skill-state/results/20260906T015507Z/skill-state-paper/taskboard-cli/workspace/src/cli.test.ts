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
  test("adds normalized tasks and persists increasing IDs", async () => {
    const first = await cli("add", "--title", " First task ", "--tags", "Work, work, HOME", "--due", "2099-02-28");
    const second = await cli("add", "--title", "Second task");
    expect(first.exitCode).toBe(0);
    expect(first.value).toMatchObject({ id: 1, title: "First task", status: "open", tags: ["work", "home"], due: "2099-02-28" });
    expect(second.value.id).toBe(2);
    expect((await cli("list")).value.map((task: { id: number }) => task.id)).toEqual([1, 2]);
  });

  test("combines filters and handles done idempotently", async () => {
    await cli("add", "--title", "Old", "--tags", "work", "--due", "2020-01-01");
    await cli("add", "--title", "Future", "--tags", "work", "--due", "2099-01-01");
    const done = await cli("done", "2");
    const repeated = await cli("done", "2");
    expect(done.value.completedAt).toBe(repeated.value.completedAt);
    expect((await cli("list", "--status", "open", "--tag", "WORK", "--overdue", "2021-01-01")).value).toHaveLength(1);
    expect((await cli("stats")).value).toEqual({ total: 2, open: 1, done: 1, overdue: 1 });
  });

  test("deletes tasks without reusing IDs", async () => {
    await cli("add", "--title", "One");
    expect((await cli("delete", "1")).value.id).toBe(1);
    expect((await cli("add", "--title", "Two")).value.id).toBe(2);
  });

  test("rejects invalid input and preserves malformed data", async () => {
    expect((await cli("add", "--title", "", "--due", "2024-02-30")).exitCode).toBe(1);
    expect((await cli("add", "--title", "x", "--wat", "y")).exitCode).toBe(1);
    await writeFile(database, "not json\n");
    const malformed = await cli("add", "--title", "safe");
    expect(malformed.exitCode).toBe(1);
    expect(malformed.stdout).toBe("");
    expect(await readFile(database, "utf8")).toBe("not json\n");
  });
});
