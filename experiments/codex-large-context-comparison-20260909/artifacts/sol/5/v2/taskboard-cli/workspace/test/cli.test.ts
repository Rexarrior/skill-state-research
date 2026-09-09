import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const project = join(import.meta.dir, "..");
const directories: string[] = [];

async function invoke(directory: string, ...args: string[]) {
  const file = join(directory, "tasks.json");
  const process = Bun.spawn(["bun", "run", "src/cli.ts", ...args], {
    cwd: project,
    env: { ...Bun.env, TASKBOARD_FILE: file },
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

async function directory() {
  const value = await mkdtemp(join(tmpdir(), "taskboard-test-"));
  directories.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

describe("taskboard CLI", () => {
  test("persists tasks, normalizes tags, filters, and keeps IDs stable", async () => {
    const dir = await directory();
    const first = await invoke(dir, "add", "--title", " First task ", "--tags", "Work, work, HOME", "--due", "2000-01-01");
    expect(first.exitCode).toBe(0);
    expect(first.value).toMatchObject({ id: 1, title: "First task", status: "open", tags: ["work", "home"], due: "2000-01-01" });
    expect(first.value.createdAt).toBeString();

    await invoke(dir, "add", "--title", "Second", "--tags", "home");
    expect((await invoke(dir, "list", "--status", "open", "--tag", " HOME ")).value.map((task: any) => task.id)).toEqual([1, 2]);
    expect((await invoke(dir, "list", "--overdue", "2000-01-02")).value.map((task: any) => task.id)).toEqual([1]);

    const completed = await invoke(dir, "done", "1");
    const completedAgain = await invoke(dir, "done", "1");
    expect(completed.value.completedAt).toBe(completedAgain.value.completedAt);
    expect((await invoke(dir, "delete", "2")).value.id).toBe(2);
    expect((await invoke(dir, "add", "--title", "Third")).value.id).toBe(3);
    expect((await invoke(dir, "list")).value.map((task: any) => task.id)).toEqual([1, 3]);
  });

  test("reports stats and rejects invalid input without replacing the database", async () => {
    const dir = await directory();
    await invoke(dir, "add", "--title", "Old", "--due", "2000-01-01");
    await invoke(dir, "add", "--title", "Future", "--due", "2999-01-01");
    await invoke(dir, "done", "2");
    expect((await invoke(dir, "stats")).value).toEqual({ total: 2, open: 1, done: 1, overdue: 1 });

    const badDate = await invoke(dir, "add", "--title", "Bad", "--due", "2025-02-29");
    expect(badDate.exitCode).not.toBe(0);
    expect(badDate.value.error).toContain("valid date");
    expect((await invoke(dir, "list")).value).toHaveLength(2);
  });

  test("rejects malformed storage, unknown flags, and missing tasks", async () => {
    const dir = await directory();
    const file = join(dir, "tasks.json");
    await writeFile(file, "not json");
    const malformed = await invoke(dir, "list");
    expect(malformed.exitCode).not.toBe(0);
    expect(malformed.value).toEqual({ error: "malformed taskboard database" });
    expect(await readFile(file, "utf8")).toBe("not json");

    await rm(file);
    expect((await invoke(dir, "add", "--title", "x", "--wat", "x")).exitCode).not.toBe(0);
    expect((await invoke(dir, "done", "99")).exitCode).not.toBe(0);
    expect((await invoke(dir, "wat")).exitCode).not.toBe(0);
  });
});
