import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const cli = join(import.meta.dir, "..", "src", "cli.ts");
const directories: string[] = [];

async function invoke(args: string[], file: string) {
  const process = Bun.spawn(["bun", "run", cli, ...args], {
    env: { ...Bun.env, TASKBOARD_FILE: file },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  return { value: JSON.parse(stdout), stdout, stderr, exitCode };
}

async function newDatabasePath() {
  const directory = await mkdtemp(join(tmpdir(), "taskboard-test-"));
  directories.push(directory);
  return join(directory, "tasks.json");
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("taskboard CLI", () => {
  test("persists additions across processes and normalizes tags", async () => {
    const file = await newDatabasePath();
    const added = await invoke(["add", "--title", "  Ship it  ", "--tags", "Work, work, READY ", "--due", "2030-01-02"], file);
    expect(added.exitCode).toBe(0);
    expect(added.value).toMatchObject({ id: 1, title: "Ship it", status: "open", tags: ["work", "ready"], due: "2030-01-02" });

    const listed = await invoke(["list", "--tag", "WORK", "--status", "open"], file);
    expect(listed.value).toHaveLength(1);
    expect(listed.value[0].id).toBe(1);
  });

  test("filters overdue tasks strictly and combines filters", async () => {
    const file = await newDatabasePath();
    await invoke(["add", "--title", "old", "--tags", "x", "--due", "2024-01-01"], file);
    await invoke(["add", "--title", "boundary", "--tags", "x", "--due", "2024-01-02"], file);
    await invoke(["add", "--title", "untagged", "--due", "2023-01-01"], file);
    const result = await invoke(["list", "--tag", "x", "--overdue", "2024-01-02"], file);
    expect(result.value.map((task: { title: string }) => task.title)).toEqual(["old"]);
  });

  test("done is idempotent, delete persists, and IDs are not reused", async () => {
    const file = await newDatabasePath();
    await invoke(["add", "--title", "one"], file);
    const first = await invoke(["done", "1"], file);
    const second = await invoke(["done", "1"], file);
    expect(second.value.completedAt).toBe(first.value.completedAt);
    expect((await invoke(["delete", "1"], file)).value).toEqual({ deleted: 1 });
    expect((await invoke(["add", "--title", "two"], file)).value.id).toBe(2);
  });

  test("reports stats", async () => {
    const file = await newDatabasePath();
    await invoke(["add", "--title", "late", "--due", "2000-01-01"], file);
    await invoke(["add", "--title", "done", "--due", "2000-01-01"], file);
    await invoke(["done", "2"], file);
    expect((await invoke(["stats"], file)).value).toEqual({ total: 2, open: 1, done: 1, overdue: 1 });
  });

  test("rejects bad input without replacing malformed data", async () => {
    const file = await newDatabasePath();
    const invalidDate = await invoke(["add", "--title", "bad", "--due", "2024-02-30"], file);
    expect(invalidDate.exitCode).not.toBe(0);
    expect(invalidDate.value.error).toContain("valid YYYY-MM-DD");

    await writeFile(file, "not json\n");
    const malformed = await invoke(["list"], file);
    expect(malformed.exitCode).not.toBe(0);
    expect(await readFile(file, "utf8")).toBe("not json\n");
  });

  test("rejects unknown commands, flags, and missing tasks", async () => {
    const file = await newDatabasePath();
    for (const args of [["wat"], ["list", "--wat", "x"], ["done", "42"]]) {
      const result = await invoke(args, file);
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout.trim().split("\n")).toHaveLength(1);
      expect(result.stderr.length).toBeGreaterThan(0);
    }
  });
});
