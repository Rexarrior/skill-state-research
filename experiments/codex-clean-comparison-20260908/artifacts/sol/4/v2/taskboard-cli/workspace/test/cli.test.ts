import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const cli = join(import.meta.dir, "..", "src", "cli.ts");
const directories: string[] = [];

async function run(directory: string, ...args: string[]) {
  const process = Bun.spawn(["bun", "run", cli, ...args], {
    cwd: directory,
    env: { ...Bun.env, TASKBOARD_FILE: join(directory, "tasks.json") },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  return { exitCode, stdout: stdout.trim(), stderr: stderr.trim(), json: JSON.parse(stdout) };
}

async function workspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "taskboard-test-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("taskboard CLI", () => {
  test("adds, normalizes, persists, lists, completes, and deletes tasks", async () => {
    const directory = await workspace();
    const first = await run(directory, "add", "--title", "  Ship release  ", "--tags", "Work, urgent,work", "--due", "2000-02-29");
    expect(first.exitCode).toBe(0);
    expect(first.json).toMatchObject({ id: 1, title: "Ship release", status: "open", tags: ["work", "urgent"], due: "2000-02-29" });
    expect(first.json.createdAt).toBeString();

    const second = await run(directory, "add", "--title", "Later", "--tags", "Home");
    expect(second.json.id).toBe(2);
    expect((await run(directory, "list", "--status", "open", "--tag", "WORK")).json.map((task: any) => task.id)).toEqual([1]);
    expect((await run(directory, "list", "--overdue", "2000-03-01")).json.map((task: any) => task.id)).toEqual([1]);

    const done = await run(directory, "done", "1");
    expect(done.json.status).toBe("done");
    const completedAt = done.json.completedAt;
    expect((await run(directory, "done", "1")).json.completedAt).toBe(completedAt);
    expect((await run(directory, "delete", "1")).json.id).toBe(1);
    expect((await run(directory, "list")).json.map((task: any) => task.id)).toEqual([2]);
    expect((await run(directory, "add", "--title", "Stable ID")).json.id).toBe(3);
  });

  test("reports statistics", async () => {
    const directory = await workspace();
    await run(directory, "add", "--title", "Old", "--due", "2000-01-01");
    await run(directory, "add", "--title", "Done", "--due", "2000-01-01");
    await run(directory, "done", "2");
    expect((await run(directory, "stats")).json).toEqual({ total: 2, open: 1, done: 1, overdue: 1 });
  });

  test("rejects bad input and preserves malformed databases", async () => {
    const directory = await workspace();
    for (const args of [
      ["add", "--title", ""],
      ["add", "--title", "Bad date", "--due", "2023-02-29"],
      ["list", "--wat", "x"],
      ["done", "99"],
      ["unknown"],
    ]) {
      const result = await run(directory, ...args);
      expect(result.exitCode).not.toBe(0);
      expect(result.json.error).toBeString();
      expect(result.stderr.length).toBeGreaterThan(0);
    }

    const path = join(directory, "tasks.json");
    await writeFile(path, "not json");
    const result = await run(directory, "list");
    expect(result.exitCode).not.toBe(0);
    expect(await readFile(path, "utf8")).toBe("not json");
  });

  test("emits exactly one JSON value on success and failure", async () => {
    const directory = await workspace();
    const success = await run(directory, "list");
    expect(success.stdout).toBe("[]");
    const failure = await run(directory);
    expect(failure.stdout.split("\n")).toHaveLength(1);
    expect(failure.json).toHaveProperty("error");
  });
});
