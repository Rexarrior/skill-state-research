import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const cli = join(import.meta.dir, "..", "src", "cli.ts");
let directory: string;
let database: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "taskboard-test-"));
  database = join(directory, "tasks.json");
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function invoke(...args: string[]) {
  const process = Bun.spawn([processExec(), "run", cli, ...args], {
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
  return { exitCode, stderr, stdout, json: JSON.parse(stdout) };
}

function processExec(): string {
  return process.execPath;
}

describe("taskboard CLI", () => {
  test("persists, filters, completes, deletes, and never reuses IDs", async () => {
    const first = await invoke("add", "--title", " First task ", "--tags", "Work, work, HOME", "--due", "2000-01-01");
    expect(first.exitCode).toBe(0);
    expect(first.json).toMatchObject({ id: 1, title: "First task", status: "open", tags: ["work", "home"] });

    const second = await invoke("add", "--title", "Second", "--tags", "home", "--due", "2999-01-01");
    expect(second.json.id).toBe(2);
    expect((await invoke("list", "--status", "open", "--tag", "HOME")).json.map((task: { id: number }) => task.id)).toEqual([1, 2]);
    expect((await invoke("list", "--overdue", "2020-01-01")).json.map((task: { id: number }) => task.id)).toEqual([1]);

    const completed = await invoke("done", "1");
    const completedAgain = await invoke("done", "1");
    expect(completedAgain.json.completedAt).toBe(completed.json.completedAt);
    expect((await invoke("stats")).json).toEqual({ total: 2, open: 1, done: 1, overdue: 0 });

    expect((await invoke("delete", "2")).json.id).toBe(2);
    expect((await invoke("add", "--title", "Third")).json.id).toBe(3);
  });

  test("rejects bad input and preserves malformed data", async () => {
    expect((await invoke("add", "--title", "x", "--due", "2023-02-29")).exitCode).toBe(1);
    expect((await invoke("add", "--title", "early", "--due", "0004-02-29")).exitCode).toBe(0);
    expect((await invoke("wat")).json.error).toContain("unknown command");

    await writeFile(database, "not json\n");
    const result = await invoke("add", "--title", "must not overwrite");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("malformed database");
    expect(await readFile(database, "utf8")).toBe("not json\n");
  });
});
