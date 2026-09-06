import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const cli = join(import.meta.dir, "..", "src", "cli.ts");
const directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "taskboard-test-"));
  directories.push(directory);
  return directory;
}

async function invoke(directory: string, args: string[]) {
  const database = join(directory, "tasks.json");
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
  return { value: JSON.parse(stdout), stdout, stderr, exitCode, database };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("taskboard CLI", () => {
  test("persists tasks across processes and normalizes tags", async () => {
    const directory = await temporaryDirectory();
    const first = await invoke(directory, [
      "add", "--title", "First", "--tags", " Work,work, URGENT ", "--due", "2024-02-29",
    ]);
    const second = await invoke(directory, ["add", "--title=Second"]);
    const listed = await invoke(directory, ["list", "--tag", "WORK"]);

    expect(first.exitCode).toBe(0);
    expect(first.value).toMatchObject({ id: 1, status: "open", tags: ["work", "urgent"] });
    expect(second.value.id).toBe(2);
    expect(listed.value.map((task: { id: number }) => task.id)).toEqual([1]);
  });

  test("combines filters and completes idempotently", async () => {
    const directory = await temporaryDirectory();
    await invoke(directory, ["add", "--title", "Old", "--tags", "x", "--due", "2020-01-01"]);
    await invoke(directory, ["add", "--title", "New", "--tags", "x", "--due", "2030-01-01"]);
    const overdue = await invoke(directory, ["list", "--status", "open", "--tag", "x", "--overdue", "2025-01-01"]);
    expect(overdue.value.map((task: { id: number }) => task.id)).toEqual([1]);

    const completed = await invoke(directory, ["done", "1"]);
    const repeated = await invoke(directory, ["done", "1"]);
    expect(repeated.value.completedAt).toBe(completed.value.completedAt);

    const summary = await invoke(directory, ["stats"]);
    expect(summary.value).toEqual({ total: 2, open: 1, done: 1, overdue: 0 });
  });

  test("deletes without reusing ids", async () => {
    const directory = await temporaryDirectory();
    await invoke(directory, ["add", "--title", "One"]);
    expect((await invoke(directory, ["delete", "1"])).value).toEqual({ deleted: 1 });
    expect((await invoke(directory, ["add", "--title", "Two"])).value.id).toBe(2);
  });

  test("rejects invalid input and preserves malformed data", async () => {
    const directory = await temporaryDirectory();
    const invalidDate = await invoke(directory, ["add", "--title", "Bad", "--due", "2023-02-29"]);
    expect(invalidDate.exitCode).not.toBe(0);
    expect(invalidDate.stdout.trim().split("\n")).toHaveLength(1);
    expect(invalidDate.value.error).toContain("valid YYYY-MM-DD");

    const database = join(directory, "tasks.json");
    await writeFile(database, "not json\n");
    const malformed = await invoke(directory, ["list"]);
    expect(malformed.exitCode).not.toBe(0);
    expect(malformed.stderr).toContain("malformed");
    expect(await readFile(database, "utf8")).toBe("not json\n");
  });

  test("rejects unknown and duplicate flags", async () => {
    const directory = await temporaryDirectory();
    expect((await invoke(directory, ["list", "--wat", "x"])).exitCode).not.toBe(0);
    expect((await invoke(directory, ["add", "--title", "a", "--title", "b"])).exitCode).not.toBe(0);
  });

  test("every failure emits one JSON value", async () => {
    const directory = await temporaryDirectory();
    const process = Bun.spawn(["bun", "run", cli, "list"], {
      cwd: directory,
      env: { ...Bun.env, TASKBOARD_FILE: "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(process.stdout).text();
    expect(await process.exited).not.toBe(0);
    expect(stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(stdout).error).toContain("must not be empty");
  });
});
