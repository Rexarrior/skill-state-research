import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const cli = join(import.meta.dir, "cli.ts");
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function setup(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "taskboard-test-"));
  directories.push(directory);
  return join(directory, "board.json");
}

async function invoke(file: string, args: string[]) {
  const process = Bun.spawn([processExec(), "run", cli, ...args], {
    env: { ...Bun.env, TASKBOARD_FILE: file },
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

function processExec(): string {
  return Bun.which("bun")!;
}

describe("taskboard CLI", () => {
  test("persists tasks, normalizes tags, filters, and keeps IDs stable", async () => {
    const file = await setup();
    const first = await invoke(file, ["add", "--title", " First task ", "--tags", " Work,work, Urgent ", "--due", "2000-01-01"]);
    expect(first.exitCode).toBe(0);
    expect(first.lines).toHaveLength(1);
    expect(first.value).toMatchObject({ id: 1, title: "First task", status: "open", tags: ["work", "urgent"], due: "2000-01-01" });

    const second = await invoke(file, ["add", "--title", "Second", "--tags", "home"]);
    expect(second.value.id).toBe(2);
    const filtered = await invoke(file, ["list", "--status", "open", "--tag", "WORK", "--overdue", "2001-01-01"]);
    expect(filtered.value.map((task: { id: number }) => task.id)).toEqual([1]);

    expect((await invoke(file, ["delete", "1"])).exitCode).toBe(0);
    expect((await invoke(file, ["add", "--title", "Third"])).value.id).toBe(3);
    expect((await invoke(file, ["list"])).value.map((task: { id: number }) => task.id)).toEqual([2, 3]);
  });

  test("done is idempotent and stats reflect current state", async () => {
    const file = await setup();
    await invoke(file, ["add", "--title", "Old", "--due", "2000-01-01"]);
    await invoke(file, ["add", "--title", "Active"]);
    const first = await invoke(file, ["done", "2"]);
    const repeated = await invoke(file, ["done", "2"]);
    expect(repeated.value.completedAt).toBe(first.value.completedAt);
    expect((await invoke(file, ["stats"])).value).toEqual({ total: 2, open: 1, done: 1, overdue: 1 });
  });

  test("rejects invalid input and preserves malformed databases", async () => {
    const file = await setup();
    const invalidDate = await invoke(file, ["add", "--title", "Bad", "--due", "2025-02-29"]);
    expect(invalidDate.exitCode).not.toBe(0);
    expect(invalidDate.lines).toHaveLength(1);
    expect(invalidDate.value.error).toContain("Due date");

    await writeFile(file, "not json\n");
    const malformed = await invoke(file, ["list"]);
    expect(malformed.exitCode).not.toBe(0);
    expect(malformed.stderr).toContain("Malformed");
    expect(await readFile(file, "utf8")).toBe("not json\n");
  });

  test("unknown commands, flags, and missing tasks fail", async () => {
    const file = await setup();
    expect((await invoke(file, ["wat"])).exitCode).not.toBe(0);
    expect((await invoke(file, ["list", "--wat", "x"])).exitCode).not.toBe(0);
    expect((await invoke(file, ["done", "9"])).exitCode).not.toBe(0);
  });
});
