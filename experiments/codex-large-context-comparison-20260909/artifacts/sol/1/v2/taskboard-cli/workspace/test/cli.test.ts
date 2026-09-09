import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const cli = join(import.meta.dir, "..", "src", "cli.ts");
let directory: string;
let database: string;

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
  return { value: JSON.parse(stdout), stdout, stderr, exitCode, lines };
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "taskboard-test-"));
  database = join(directory, "tasks.json");
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("taskboard CLI", () => {
  test("adds normalized tasks and persists stable IDs", async () => {
    const first = await invoke("add", "--title", "  Ship it  ", "--tags", " Work,urgent,work ", "--due", "2030-01-02");
    expect(first.exitCode).toBe(0);
    expect(first.lines).toHaveLength(1);
    expect(first.value).toMatchObject({ id: 1, title: "Ship it", status: "open", tags: ["work", "urgent"], due: "2030-01-02" });
    expect(new Date(first.value.createdAt).toISOString()).toBe(first.value.createdAt);

    expect((await invoke("add", "--title", "Second")).value.id).toBe(2);
    expect((await invoke("delete", "1")).value.id).toBe(1);
    expect((await invoke("add", "--title", "Third")).value.id).toBe(3);
  });

  test("combines list filters, sorts IDs, and uses strict overdue dates", async () => {
    await invoke("add", "--title", "Old", "--tags", "Home", "--due", "2020-01-01");
    await invoke("add", "--title", "Boundary", "--tags", "home", "--due", "2020-01-02");
    await invoke("add", "--title", "Done", "--tags", "home", "--due", "2019-01-01");
    await invoke("done", "3");
    const result = await invoke("list", "--status", "open", "--tag", " HOME ", "--overdue", "2020-01-02");
    expect(result.value.map((task: { id: number }) => task.id)).toEqual([1]);
  });

  test("done is idempotent", async () => {
    await invoke("add", "--title", "Task");
    const first = await invoke("done", "1");
    const second = await invoke("done", "1");
    expect(second.value.completedAt).toBe(first.value.completedAt);
    expect(second.value.status).toBe("done");
  });

  test("reports accurate stats", async () => {
    await invoke("add", "--title", "Ancient", "--due", "2000-01-01");
    await invoke("add", "--title", "Future", "--due", "2999-01-01");
    await invoke("add", "--title", "Finished", "--due", "2000-01-01");
    await invoke("done", "3");
    expect((await invoke("stats")).value).toEqual({ total: 3, open: 2, done: 1, overdue: 1 });
  });

  test("rejects bad input with one JSON stdout value", async () => {
    for (const args of [
      ["add", "--title", " "],
      ["add", "--title", "Bad date", "--due", "2023-02-29"],
      ["list", "--wat", "x"],
      ["done", "42"],
      ["mystery"],
    ]) {
      const result = await invoke(...args);
      expect(result.exitCode).not.toBe(0);
      expect(result.lines).toHaveLength(1);
      expect(result.value.error).toBeString();
      expect(result.stderr).toStartWith("taskboard:");
    }
  });

  test("does not replace a malformed database", async () => {
    await writeFile(database, "not json\n");
    const result = await invoke("add", "--title", "Must not appear");
    expect(result.exitCode).not.toBe(0);
    expect(result.value.error).toContain("invalid JSON");
    expect(await readFile(database, "utf8")).toBe("not json\n");
  });

  test("uses an empty in-memory database for read-only commands", async () => {
    expect((await invoke("list")).value).toEqual([]);
    expect((await invoke("stats")).value).toEqual({ total: 0, open: 0, done: 0, overdue: 0 });
  });
});
