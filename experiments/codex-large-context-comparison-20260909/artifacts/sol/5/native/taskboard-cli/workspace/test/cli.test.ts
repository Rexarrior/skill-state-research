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
  return { stdout, stderr, exitCode, json: JSON.parse(stdout) };
}

async function workspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "taskboard-test-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("taskboard CLI", () => {
  test("persists, normalizes, filters, completes, and deletes tasks", async () => {
    const directory = await workspace();
    const first = await invoke(
      directory,
      "add",
      "--title",
      "First",
      "--tags",
      " Work,work, URGENT ",
      "--due",
      "2000-02-29",
    );
    expect(first.exitCode).toBe(0);
    expect(first.json).toMatchObject({ id: 1, title: "First", status: "open", tags: ["work", "urgent"] });

    const second = await invoke(directory, "add", "--title", "Second", "--tags", "home");
    expect(second.json.id).toBe(2);
    expect((await invoke(directory, "list", "--tag", "WORK")).json.map((task: any) => task.id)).toEqual([1]);
    expect((await invoke(directory, "list", "--overdue", "2000-03-01")).json.map((task: any) => task.id)).toEqual([1]);

    const completed = await invoke(directory, "done", "1");
    expect(completed.json.status).toBe("done");
    const completedAgain = await invoke(directory, "done", "1");
    expect(completedAgain.json.completedAt).toBe(completed.json.completedAt);
    expect((await invoke(directory, "stats")).json).toEqual({ total: 2, open: 1, done: 1, overdue: 0 });

    expect((await invoke(directory, "delete", "1")).json.id).toBe(1);
    expect((await invoke(directory, "list")).json.map((task: any) => task.id)).toEqual([2]);
    expect((await invoke(directory, "add", "--title", "Third")).json.id).toBe(3);
  });

  test("rejects invalid input without replacing a malformed database", async () => {
    const directory = await workspace();
    const badDate = await invoke(directory, "add", "--title", "No", "--due", "2023-02-29");
    expect(badDate.exitCode).not.toBe(0);
    expect(badDate.json.error).toContain("valid date");
    expect(badDate.stdout.trim().split("\n")).toHaveLength(1);

    const path = join(directory, "tasks.json");
    await writeFile(path, "not json");
    const malformed = await invoke(directory, "add", "--title", "Safe");
    expect(malformed.exitCode).not.toBe(0);
    expect(malformed.stderr).toContain("malformed");
    expect(await readFile(path, "utf8")).toBe("not json");
  });

  test("rejects unknown flags and missing tasks", async () => {
    const directory = await workspace();
    expect((await invoke(directory, "list", "--wat", "x")).exitCode).not.toBe(0);
    expect((await invoke(directory, "done", "4")).exitCode).not.toBe(0);
    expect((await invoke(directory, "add", "--title", "  ")).exitCode).not.toBe(0);
  });
});
