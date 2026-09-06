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
  const lines = stdout.trim().split("\n");
  expect(lines).toHaveLength(1);
  return { exitCode, output: JSON.parse(lines[0]), stderr };
}

describe("taskboard CLI", () => {
  test("persists tasks, normalizes tags, filters, and keeps stable ids", async () => {
    const first = await invoke("add", "--title", " First task ", "--tags", "Work, work, URGENT", "--due", "2024-01-01");
    expect(first.exitCode).toBe(0);
    expect(first.output).toMatchObject({ id: 1, title: "First task", status: "open", tags: ["work", "urgent"], due: "2024-01-01" });
    expect(Date.parse(first.output.createdAt)).not.toBeNaN();

    const second = await invoke("add", "--title", "Second", "--tags", "home");
    expect(second.output.id).toBe(2);
    expect((await invoke("list", "--status", "open", "--tag", "WORK")).output.map((task: { id: number }) => task.id)).toEqual([1]);
    expect((await invoke("list", "--overdue", "2024-01-02")).output.map((task: { id: number }) => task.id)).toEqual([1]);

    expect((await invoke("delete", "1")).exitCode).toBe(0);
    expect((await invoke("add", "--title", "Third")).output.id).toBe(3);
  });

  test("done is idempotent and stats count only open overdue tasks", async () => {
    await invoke("add", "--title", "Old", "--due", "2000-01-01");
    await invoke("add", "--title", "Open");
    const done = await invoke("done", "1");
    const repeated = await invoke("done", "1");
    expect(repeated.output.completedAt).toBe(done.output.completedAt);
    expect(await invoke("stats")).toMatchObject({ exitCode: 0, output: { total: 2, open: 1, done: 1, overdue: 0 } });
  });

  test("rejects invalid input and preserves a malformed database", async () => {
    expect((await invoke("add", "--title", "x", "--due", "2023-02-29")).exitCode).not.toBe(0);
    expect((await invoke("add", "--title", " ")).exitCode).not.toBe(0);
    expect((await invoke("list", "--wat")).exitCode).not.toBe(0);

    const malformed = "{broken\n";
    await writeFile(database, malformed);
    const result = await invoke("add", "--title", "Must not overwrite");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("not valid JSON");
    expect(await readFile(database, "utf8")).toBe(malformed);
  });

  test("missing tasks fail", async () => {
    expect((await invoke("done", "99")).exitCode).not.toBe(0);
    expect((await invoke("delete", "99")).exitCode).not.toBe(0);
  });
});
