import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const cli = join(import.meta.dir, "..", "src", "cli.ts");
let directory: string;
let databaseFile: string;

interface Result {
  exitCode: number;
  stdout: unknown;
  stderr: string;
}

function run(...args: string[]): Result {
  const child = Bun.spawnSync([process.execPath, "run", cli, ...args], {
    cwd: directory,
    env: { ...Bun.env, TASKBOARD_FILE: databaseFile },
    stdout: "pipe",
    stderr: "pipe",
  });
  const text = child.stdout.toString().trim();
  return {
    exitCode: child.exitCode,
    stdout: JSON.parse(text),
    stderr: child.stderr.toString(),
  };
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "taskboard-test-"));
  databaseFile = join(directory, "tasks.json");
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("task lifecycle", () => {
  test("persists tasks, normalizes tags, filters, and preserves stable ids", () => {
    const first = run("add", "--title", " First task ", "--tags", "Work, work, HOME", "--due", "2024-01-02");
    expect(first.exitCode).toBe(0);
    expect(first.stdout).toMatchObject({ id: 1, title: "First task", status: "open", tags: ["work", "home"], due: "2024-01-02" });

    expect(run("add", "--title", "Second", "--tags", "home", "--due", "2030-01-01").stdout).toMatchObject({ id: 2 });
    expect(run("list", "--status", "open", "--tag", "HOME", "--overdue", "2025-01-01").stdout).toEqual([first.stdout]);

    const completed = run("done", "1");
    expect(completed.stdout).toMatchObject({ id: 1, status: "done" });
    expect(typeof (completed.stdout as Record<string, unknown>).completedAt).toBe("string");
    expect(run("done", "1").stdout).toEqual(completed.stdout);

    expect(run("delete", "1").stdout).toEqual(completed.stdout);
    expect(run("add", "--title", "Third").stdout).toMatchObject({ id: 3 });
    expect((run("list").stdout as Array<{ id: number }>).map((task) => task.id)).toEqual([2, 3]);
  });

  test("reports statistics", () => {
    run("add", "--title", "Old", "--due", "2000-01-01");
    run("add", "--title", "Future", "--due", "2999-01-01");
    run("add", "--title", "Finished", "--due", "2000-01-01");
    run("done", "3");
    expect(run("stats").stdout).toEqual({ total: 3, open: 2, done: 1, overdue: 1 });
  });
});

describe("failures", () => {
  test.each([
    ["empty title", ["add", "--title", "   "]],
    ["impossible date", ["add", "--title", "Bad", "--due", "2023-02-29"]],
    ["unknown command", ["nope"]],
    ["unknown flag", ["list", "--wat", "x"]],
    ["missing task", ["done", "99"]],
  ])("rejects %s with one JSON value", (_name, args) => {
    const result = run(...args);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toHaveProperty("error");
    expect(result.stderr.trim().length).toBeGreaterThan(0);
  });

  test("does not replace malformed data", async () => {
    const malformed = "{ definitely not json";
    await writeFile(databaseFile, malformed);
    const result = run("add", "--title", "Must not be saved");
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toHaveProperty("error");
    expect(await readFile(databaseFile, "utf8")).toBe(malformed);
  });
});
