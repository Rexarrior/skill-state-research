import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const cli = join(import.meta.dir, "..", "src", "cli.ts");
const directories: string[] = [];

async function setup(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "taskboard-test-"));
  directories.push(directory);
  return join(directory, "board.json");
}

async function run(file: string, ...args: string[]) {
  const proc = Bun.spawn(["bun", "run", cli, ...args], {
    env: { ...process.env, TASKBOARD_FILE: file },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("taskboard CLI", () => {
  test("persists additions with normalized unique tags and increasing IDs", async () => {
    const file = await setup();
    const first = await run(file, "add", "--title", " First task ", "--tags", "Work, work, HOME", "--due", "2099-12-31");
    const second = await run(file, "add", "--title", "Second");
    expect(first.exitCode).toBe(0);
    expect(JSON.parse(first.stdout)).toMatchObject({ id: 1, title: "First task", status: "open", tags: ["work", "home"], due: "2099-12-31" });
    expect(JSON.parse(second.stdout).id).toBe(2);
    const listed = await run(file, "list", "--tag", "WORK", "--status", "open");
    expect(JSON.parse(listed.stdout).map((task: { id: number }) => task.id)).toEqual([1]);
  });

  test("combines overdue filtering and tracks idempotent completion", async () => {
    const file = await setup();
    await run(file, "add", "--title", "Old", "--due", "2000-01-01");
    await run(file, "add", "--title", "Future", "--due", "2099-01-01");
    const overdue = await run(file, "list", "--overdue", "2020-01-01");
    expect(JSON.parse(overdue.stdout).map((task: { id: number }) => task.id)).toEqual([1]);
    const done1 = JSON.parse((await run(file, "done", "1")).stdout);
    const done2 = JSON.parse((await run(file, "done", "1")).stdout);
    expect(done1.completedAt).toBe(done2.completedAt);
    expect(JSON.parse((await run(file, "stats")).stdout)).toEqual({ total: 2, open: 1, done: 1, overdue: 0 });
  });

  test("deletes tasks without reusing IDs", async () => {
    const file = await setup();
    await run(file, "add", "--title", "One");
    expect(JSON.parse((await run(file, "delete", "1")).stdout).id).toBe(1);
    expect(JSON.parse((await run(file, "add", "--title", "Two")).stdout).id).toBe(2);
  });

  test("rejects invalid input and preserves malformed databases", async () => {
    const file = await setup();
    expect((await run(file, "add", "--title", "x", "--due", "2023-02-29")).exitCode).not.toBe(0);
    expect((await run(file, "list", "--wat", "x")).exitCode).not.toBe(0);
    expect((await run(file, "done", "99")).exitCode).not.toBe(0);
    await writeFile(file, "not json");
    expect((await run(file, "add", "--title", "x")).exitCode).not.toBe(0);
    expect(await readFile(file, "utf8")).toBe("not json");
  });
});
