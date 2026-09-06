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
  const process = Bun.spawn(["bun", "run", join(import.meta.dir, "..", "src", "cli.ts"), ...args], {
    env: { ...Bun.env, TASKBOARD_FILE: database },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  return { exitCode, stdout: stdout.trim(), stderr: stderr.trim(), value: JSON.parse(stdout) };
}

describe("taskboard CLI", () => {
  test("persists tasks, normalizes tags, filters, and keeps IDs stable", async () => {
    const first = await cli("add", "--title", " First ", "--tags", "Work, work, HOME", "--due", "2000-01-01");
    expect(first.exitCode).toBe(0);
    expect(first.value).toMatchObject({ id: 1, title: "First", status: "open", tags: ["work", "home"], due: "2000-01-01" });
    await cli("add", "--title", "Second", "--tags", "home");
    expect((await cli("list", "--status", "open", "--tag", "WORK")).value.map((task: any) => task.id)).toEqual([1]);
    expect((await cli("list", "--overdue", "2000-01-02")).value.map((task: any) => task.id)).toEqual([1]);
    await cli("delete", "1");
    expect((await cli("add", "--title", "Third")).value.id).toBe(3);
  });

  test("done is idempotent and stats are accurate", async () => {
    await cli("add", "--title", "Old", "--due", "2000-01-01");
    const first = await cli("done", "1");
    const second = await cli("done", "1");
    expect(second.value.completedAt).toBe(first.value.completedAt);
    expect((await cli("stats")).value).toEqual({ total: 1, open: 0, done: 1, overdue: 0 });
  });

  test("rejects invalid input with one JSON value", async () => {
    const result = await cli("add", "--title", "", "--due", "2025-02-30");
    expect(result.exitCode).not.toBe(0);
    expect(result.value.error).toBeString();
    expect(result.stderr).toStartWith("taskboard:");
    expect(result.stdout.split("\n")).toHaveLength(1);
  });

  test("does not replace a malformed database", async () => {
    await writeFile(database, "not json");
    const result = await cli("add", "--title", "Nope");
    expect(result.exitCode).not.toBe(0);
    expect(await readFile(database, "utf8")).toBe("not json");
  });
});
