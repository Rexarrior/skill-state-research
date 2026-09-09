import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const cli = join(import.meta.dir, "..", "src", "cli.ts");
const directories: string[] = [];

async function workspace(): Promise<{ directory: string; database: string }> {
  const directory = await mkdtemp(join(tmpdir(), "taskboard-test-"));
  directories.push(directory);
  return { directory, database: join(directory, "tasks.json") };
}

async function invoke(database: string, args: string[]) {
  const process = Bun.spawn(["bun", "run", cli, ...args], {
    env: { ...Bun.env, TASKBOARD_FILE: database },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  return { exitCode, stdout, stderr, json: JSON.parse(stdout) };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("taskboard CLI", () => {
  test("persists, filters, completes, deletes, and keeps IDs stable", async () => {
    const { database } = await workspace();
    const first = await invoke(database, ["add", "--title", " First ", "--tags", "Work, work,URGENT", "--due", "2020-02-29"]);
    expect(first.exitCode).toBe(0);
    expect(first.json).toMatchObject({ id: 1, title: "First", status: "open", tags: ["work", "urgent"], due: "2020-02-29" });

    await invoke(database, ["add", "--title", "Second"]);
    const filtered = await invoke(database, ["list", "--status", "open", "--tag", "WORK", "--overdue", "2020-03-01"]);
    expect(filtered.json.map((task: { id: number }) => task.id)).toEqual([1]);

    const completed = await invoke(database, ["done", "1"]);
    const completedAgain = await invoke(database, ["done", "1"]);
    expect(completedAgain.json.completedAt).toBe(completed.json.completedAt);

    expect((await invoke(database, ["delete", "2"])).json.id).toBe(2);
    expect((await invoke(database, ["add", "--title", "Third"])).json.id).toBe(3);
    expect((await invoke(database, ["stats"])).json).toEqual({ total: 2, open: 1, done: 1, overdue: 0 });
  });

  test("rejects bad input and leaves malformed data untouched", async () => {
    const { database } = await workspace();
    const badDate = await invoke(database, ["add", "--title", "Bad", "--due", "2023-02-29"]);
    expect(badDate.exitCode).not.toBe(0);
    expect(badDate.json.error).toContain("due date");
    expect(badDate.stderr).toContain("due date");

    await writeFile(database, "not json\n");
    const malformed = await invoke(database, ["list"]);
    expect(malformed.exitCode).not.toBe(0);
    expect(await readFile(database, "utf8")).toBe("not json\n");
  });

  test("rejects unknown flags and missing tasks", async () => {
    const { database } = await workspace();
    expect((await invoke(database, ["list", "--wat", "x"])).exitCode).not.toBe(0);
    expect((await invoke(database, ["done", "9"])).exitCode).not.toBe(0);
    expect((await invoke(database, ["delete", "9"])).exitCode).not.toBe(0);
  });

  test("uses strict calendar dates and always emits one JSON value", async () => {
    const { database } = await workspace();
    for (const due of ["2024-04-31", "2024-13-01", "0000-01-01", "24-01-01"]) {
      const result = await invoke(database, ["add", "--title", "Bad date", "--due", due]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout.trim().split("\n")).toHaveLength(1);
    }
    expect((await invoke(database, ["add", "--title", "Early", "--due", "0001-01-01"])).exitCode).toBe(0);
  });
});
