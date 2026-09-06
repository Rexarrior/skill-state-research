import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const cli = join(import.meta.dir, "..", "src", "cli.ts");
let directory: string;
let file: string;

async function run(...args: string[]) {
  const process = Bun.spawn(["bun", "run", cli, ...args], {
    cwd: directory,
    env: { ...Bun.env, TASKBOARD_FILE: file },
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

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "taskboard-test-"));
  file = join(directory, "board.json");
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("taskboard CLI", () => {
  test("persists, normalizes, filters, completes, and keeps ids stable", async () => {
    const first = await run("add", "--title", " First task ", "--tags", "Work, work, HOME", "--due", "2000-01-02");
    expect(first.exitCode).toBe(0);
    expect(first.json).toMatchObject({ id: 1, title: "First task", status: "open", tags: ["work", "home"] });
    expect((await run("add", "--title", "Second")).json.id).toBe(2);
    expect((await run("list", "--tag", "WORK", "--overdue", "2000-01-03")).json.map((task: any) => task.id)).toEqual([1]);
    const completed = await run("done", "1");
    const completedAgain = await run("done", "1");
    expect(completed.json.completedAt).toBe(completedAgain.json.completedAt);
    expect((await run("delete", "2")).json.id).toBe(2);
    expect((await run("add", "--title", "Third")).json.id).toBe(3);
    expect((await run("list")).json.map((task: any) => task.id)).toEqual([1, 3]);
  });

  test("reports stats", async () => {
    await run("add", "--title", "Late", "--due", "2000-01-01");
    await run("add", "--title", "Open");
    await run("add", "--title", "Done");
    await run("done", "3");
    expect((await run("stats")).json).toEqual({ total: 3, open: 2, done: 1, overdue: 1 });
  });

  test("rejects bad input and preserves malformed data", async () => {
    expect((await run("add", "--title", "x", "--due", "2023-02-29")).exitCode).not.toBe(0);
    expect((await run("list", "--wat", "x")).exitCode).not.toBe(0);
    await writeFile(file, "not-json\n");
    expect((await run("add", "--title", "must not replace")).exitCode).not.toBe(0);
    expect(await readFile(file, "utf8")).toBe("not-json\n");
  });
});
