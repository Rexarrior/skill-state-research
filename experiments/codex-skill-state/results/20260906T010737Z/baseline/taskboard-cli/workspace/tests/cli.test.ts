import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const project = join(import.meta.dir, "..");
const temporaryDirectories: string[] = [];

async function invoke(file: string, ...args: string[]) {
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

async function freshDatabase(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "taskboard-test-"));
  temporaryDirectories.push(directory);
  return join(directory, "tasks.json");
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("taskboard CLI", () => {
  test("persists, filters, completes, and deletes tasks across processes", async () => {
    const file = await freshDatabase();
    const first = await invoke(file, "add", "--title", " First task ", "--tags", "Work,work, Urgent", "--due", "2020-01-02");
    expect(first.exitCode).toBe(0);
    expect(first.value).toMatchObject({ id: 1, title: "First task", status: "open", tags: ["work", "urgent"] });

    const second = await invoke(file, "add", "--title", "Second", "--tags", "home", "--due", "2099-01-01");
    expect(second.value.id).toBe(2);
    expect((await invoke(file, "list", "--status", "open", "--tag", "WORK")).value.map((task: { id: number }) => task.id)).toEqual([1]);
    expect((await invoke(file, "list", "--overdue", "2021-01-01")).value.map((task: { id: number }) => task.id)).toEqual([1]);

    const completed = await invoke(file, "done", "1");
    expect(completed.value.status).toBe("done");
    const completedAgain = await invoke(file, "done", "1");
    expect(completedAgain.value.completedAt).toBe(completed.value.completedAt);
    expect((await invoke(file, "stats")).value).toEqual({ total: 2, open: 1, done: 1, overdue: 0 });

    expect((await invoke(file, "delete", "2")).value.id).toBe(2);
    expect((await invoke(file, "list")).value.map((task: { id: number }) => task.id)).toEqual([1]);
    const third = await invoke(file, "add", "--title", "Third");
    expect(third.value.id).toBe(3);
  });

  test("rejects bad input and preserves malformed data", async () => {
    const file = await freshDatabase();
    const badDate = await invoke(file, "add", "--title", "Bad", "--due", "2025-02-29");
    expect(badDate.exitCode).not.toBe(0);
    expect(badDate.value.error).toContain("valid calendar date");

    await writeFile(file, "definitely not json\n");
    const result = await invoke(file, "add", "--title", "Do not overwrite");
    expect(result.exitCode).not.toBe(0);
    expect(await readFile(file, "utf8")).toBe("definitely not json\n");
  });

  test("rejects unknown flags and missing tasks", async () => {
    const file = await freshDatabase();
    expect((await invoke(file, "list", "--wat", "x")).exitCode).not.toBe(0);
    expect((await invoke(file, "done", "42")).exitCode).not.toBe(0);
    expect((await invoke(file, "delete", "42")).exitCode).not.toBe(0);
  });
});
