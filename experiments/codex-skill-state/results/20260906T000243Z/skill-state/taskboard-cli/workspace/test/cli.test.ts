import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const cli = join(import.meta.dir, "..", "src", "cli.ts");
const directories: string[] = [];

async function invoke(directory: string, ...args: string[]) {
  const file = join(directory, "tasks.json");
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
  return { exitCode, stdout, stderr, value: JSON.parse(stdout) };
}

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "taskboard-test-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("taskboard CLI", () => {
  test("persists, filters, completes, and counts tasks across processes", async () => {
    const directory = await temporaryDirectory();
    const first = await invoke(directory, "add", "--title", " Ship it ", "--tags", "Work, work, URGENT", "--due", "2000-01-01");
    const second = await invoke(directory, "add", "--title=Later", "--tags", "home");
    expect(first.exitCode).toBe(0);
    expect(first.value).toMatchObject({ id: 1, title: "Ship it", status: "open", tags: ["work", "urgent"] });
    expect(second.value.id).toBe(2);
    expect((await invoke(directory, "list", "--tag", "WORK")).value.map((task: { id: number }) => task.id)).toEqual([1]);
    expect((await invoke(directory, "list", "--overdue", "2000-01-02")).value.map((task: { id: number }) => task.id)).toEqual([1]);
    const done = await invoke(directory, "done", "1");
    const doneAgain = await invoke(directory, "done", "1");
    expect(done.value.completedAt).toBe(doneAgain.value.completedAt);
    expect((await invoke(directory, "stats")).value).toEqual({ total: 2, open: 1, done: 1, overdue: 0 });
    expect((await invoke(directory, "delete", "1")).value).toEqual({ deleted: 1 });
    expect((await invoke(directory, "add", "--title", "Third")).value.id).toBe(3);
  });

  test("rejects invalid input and preserves a malformed database", async () => {
    const directory = await temporaryDirectory();
    expect((await invoke(directory, "add", "--title", "x", "--due", "2025-02-29")).exitCode).toBe(1);
    const file = join(directory, "tasks.json");
    await writeFile(file, "not json\n");
    const result = await invoke(directory, "list");
    expect(result.exitCode).toBe(1);
    expect(result.value.error).toContain("malformed");
    expect(result.stderr).not.toBe("");
    expect(await readFile(file, "utf8")).toBe("not json\n");
  });

  test("rejects unknown commands, flags, and missing tasks with one JSON value", async () => {
    const directory = await temporaryDirectory();
    for (const args of [["wat"], ["list", "--wat", "x"], ["done", "42"]]) {
      const result = await invoke(directory, ...args);
      expect(result.exitCode).toBe(1);
      expect(result.value.error).toBeString();
      expect(result.stdout.trim().split("\n")).toHaveLength(1);
    }
  });
});
