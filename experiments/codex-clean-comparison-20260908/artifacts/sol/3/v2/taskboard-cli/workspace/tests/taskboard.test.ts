import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const cli = join(import.meta.dir, "..", "src", "cli.ts");
const directories: string[] = [];

async function workspace(): Promise<{ directory: string; database: string }> {
  const directory = await mkdtemp(join(tmpdir(), "taskboard-test-"));
  directories.push(directory);
  return { directory, database: join(directory, "board.json") };
}

async function run(database: string, args: string[]) {
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
  return { stdout, stderr, exitCode, json: stdout ? JSON.parse(stdout) : undefined };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("taskboard CLI", () => {
  test("persists tasks, normalizes tags, filters, completes, and deletes", async () => {
    const { database } = await workspace();
    const first = await run(database, ["add", "--title", "First", "--tags", " Work,work, Urgent ", "--due", "2000-01-01"]);
    expect(first.exitCode).toBe(0);
    expect(first.json).toMatchObject({ id: 1, status: "open", tags: ["work", "urgent"], due: "2000-01-01" });
    expect(first.stdout.trim().split("\n")).toHaveLength(1);

    const second = await run(database, ["add", "--title", "Second", "--tags", "home"]);
    expect(second.json.id).toBe(2);
    expect((await run(database, ["list", "--status", "open", "--tag", "WORK"])).json.map((task: any) => task.id)).toEqual([1]);
    expect((await run(database, ["list", "--overdue", "2000-01-02"])).json.map((task: any) => task.id)).toEqual([1]);

    const completed = await run(database, ["done", "1"]);
    const completedAgain = await run(database, ["done", "1"]);
    expect(completed.json.completedAt).toBe(completedAgain.json.completedAt);
    expect((await run(database, ["stats"])).json).toEqual({ total: 2, open: 1, done: 1, overdue: 0 });

    expect((await run(database, ["delete", "2"])).json.id).toBe(2);
    expect((await run(database, ["list"])).json.map((task: any) => task.id)).toEqual([1]);
    const third = await run(database, ["add", "--title", "Third"]);
    expect(third.json.id).toBe(3);
  });

  test("rejects malformed input and preserves malformed data", async () => {
    const { database } = await workspace();
    for (const args of [
      ["add", "--title", ""],
      ["add", "--title", "x", "--due", "2023-02-29"],
      ["add", "--title", "x", "--wat", "yes"],
      ["wat"],
      ["done", "99"],
    ]) {
      const result = await run(database, args);
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr.length).toBeGreaterThan(0);
    }

    await writeFile(database, "not json\n");
    const result = await run(database, ["list"]);
    expect(result.exitCode).not.toBe(0);
    expect(await readFile(database, "utf8")).toBe("not json\n");
  });
});
