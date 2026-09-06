import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const cli = join(import.meta.dir, "..", "src", "cli.ts");
const directories: string[] = [];

async function workspace(): Promise<{ directory: string; database: string }> {
  const directory = await mkdtemp(join(tmpdir(), "taskboard-test-"));
  directories.push(directory);
  return { directory, database: join(directory, "board.json") };
}

async function run(database: string, ...args: string[]) {
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
  return { exitCode, stdout: stdout.trim(), stderr: stderr.trim(), json: JSON.parse(stdout) };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("taskboard CLI", () => {
  test("persists tasks across processes and normalizes tags", async () => {
    const { database } = await workspace();
    const first = await run(database, "add", "--title", " First task ", "--tags", "Work, work, HOME", "--due", "2099-12-01");
    const second = await run(database, "add", "--title", "Second");
    const listed = await run(database, "list", "--tag", "WORK");
    expect(first.exitCode).toBe(0);
    expect(first.json).toMatchObject({ id: 1, title: "First task", status: "open", tags: ["work", "home"], due: "2099-12-01" });
    expect(second.json.id).toBe(2);
    expect(listed.json.map((task: { id: number }) => task.id)).toEqual([1]);
  });

  test("combines filters and uses strict overdue comparison", async () => {
    const { database } = await workspace();
    await run(database, "add", "--title", "Old", "--tags", "x", "--due", "2020-01-01");
    await run(database, "add", "--title", "Boundary", "--tags", "x", "--due", "2020-01-02");
    await run(database, "done", "2");
    const listed = await run(database, "list", "--status", "open", "--tag", "x", "--overdue", "2020-01-02");
    expect(listed.json.map((task: { id: number }) => task.id)).toEqual([1]);
    expect((await run(database, "stats")).json).toEqual({ total: 2, open: 1, done: 1, overdue: 1 });
  });

  test("done is idempotent, delete preserves monotonic IDs", async () => {
    const { database } = await workspace();
    await run(database, "add", "--title", "One");
    const completed = await run(database, "done", "1");
    const repeated = await run(database, "done", "1");
    expect(repeated.json.completedAt).toBe(completed.json.completedAt);
    expect((await run(database, "delete", "1")).json.id).toBe(1);
    expect((await run(database, "add", "--title", "Two")).json.id).toBe(2);
  });

  test("rejects invalid input with one JSON stdout value", async () => {
    const { database } = await workspace();
    for (const args of [
      ["add", "--title", "  "],
      ["add", "--title", "x", "--due", "2023-02-29"],
      ["list", "--wat", "x"],
      ["done", "99"],
      ["unknown"],
    ]) {
      const result = await run(database, ...args);
      expect(result.exitCode).not.toBe(0);
      expect(result.json).toBeNull();
      expect(result.stderr.length).toBeGreaterThan(0);
    }
  });

  test("does not replace a malformed database or leave temporary files", async () => {
    const { directory, database } = await workspace();
    const malformed = "{ definitely not json\n";
    await writeFile(database, malformed);
    const result = await run(database, "add", "--title", "Nope");
    expect(result.exitCode).not.toBe(0);
    expect(await readFile(database, "utf8")).toBe(malformed);
    expect(await readdir(directory)).toEqual(["board.json"]);
  });
});
