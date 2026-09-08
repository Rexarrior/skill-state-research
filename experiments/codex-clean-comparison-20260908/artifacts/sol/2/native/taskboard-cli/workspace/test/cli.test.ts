import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "taskboard-test-"));
  directories.push(directory);
  const database = join(directory, "tasks.json");
  const cli = join(import.meta.dir, "..", "src", "cli.ts");

  async function run(...args: string[]) {
    const process = Bun.spawn(["bun", "run", cli, ...args], {
      cwd: directory,
      env: { ...Bun.env, TASKBOARD_FILE: database },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    return { exitCode, stdout, stderr, json: JSON.parse(stdout) };
  }
  return { database, run };
}

describe("taskboard CLI", () => {
  test("persists tasks, normalizes tags, filters, and keeps IDs stable", async () => {
    const { run } = await setup();
    const first = await run("add", "--title", " First task ", "--tags", "Work, work, URGENT", "--due", "2024-02-29");
    expect(first.exitCode).toBe(0);
    expect(first.json).toMatchObject({ id: 1, title: "First task", status: "open", tags: ["work", "urgent"] });

    const second = await run("add", "--title", "Second", "--due", "2024-03-02");
    expect(second.json.id).toBe(2);
    expect((await run("list", "--tag", " WORK ")).json.map((task: { id: number }) => task.id)).toEqual([1]);
    expect((await run("list", "--overdue", "2024-03-01")).json.map((task: { id: number }) => task.id)).toEqual([1]);

    expect((await run("delete", "1")).json.id).toBe(1);
    expect((await run("add", "--title", "Third")).json.id).toBe(3);
  });

  test("done is idempotent and stats count only open overdue tasks", async () => {
    const { run } = await setup();
    await run("add", "--title", "Old", "--due", "0001-01-01");
    await run("add", "--title", "Future", "--due", "9999-12-31");
    const done = await run("done", "1");
    const repeated = await run("done", "1");
    expect(repeated.json.completedAt).toBe(done.json.completedAt);
    expect((await run("stats")).json).toEqual({ total: 2, open: 1, done: 1, overdue: 0 });
  });

  test("rejects invalid input and malformed data without replacing it", async () => {
    const { database, run } = await setup();
    expect((await run("add", "--title", "x", "--due", "2023-02-29")).exitCode).toBe(1);
    expect((await run("add", "--wat", "x")).exitCode).toBe(1);
    await writeFile(database, "not json\n");
    const result = await run("list");
    expect(result.exitCode).toBe(1);
    expect(result.json.error).toBe("Malformed task database");
    expect(await readFile(database, "utf8")).toBe("not json\n");
  });
});
