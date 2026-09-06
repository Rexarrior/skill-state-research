import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const project = join(import.meta.dir, "..");
const directories: string[] = [];

async function freshDatabase(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "taskboard-test-"));
  directories.push(directory);
  return join(directory, "tasks.json");
}

async function run(database: string, args: string[]) {
  const process = Bun.spawn(["bun", "run", "src/cli.ts", ...args], {
    cwd: project,
    env: { ...Bun.env, TASKBOARD_FILE: database },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  const lines = stdout.trim().split("\n");
  expect(lines).toHaveLength(1);
  return { value: JSON.parse(lines[0]), stderr, exitCode };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("taskboard CLI", () => {
  test("persists normalized tasks and monotonically increasing IDs", async () => {
    const database = await freshDatabase();
    const first = await run(database, [
      "add", "--title", " First task ", "--tags", "Work, work, URGENT", "--due", "2030-12-31",
    ]);
    expect(first.exitCode).toBe(0);
    expect(first.value).toMatchObject({
      id: 1, title: "First task", status: "open", tags: ["work", "urgent"], due: "2030-12-31",
    });
    expect(new Date(first.value.createdAt).toISOString()).toBe(first.value.createdAt);

    expect((await run(database, ["delete", "1"])).exitCode).toBe(0);
    const second = await run(database, ["add", "--title", "Second task"]);
    expect(second.value.id).toBe(2);
    expect((await run(database, ["list"])).value.map((task: { id: number }) => task.id)).toEqual([2]);
  });

  test("accepts text beginning with dashes as a flag value", async () => {
    const database = await freshDatabase();
    const result = await run(database, ["add", "--title", "--follow-up", "--tags", "--meta"]);
    expect(result.exitCode).toBe(0);
    expect(result.value).toMatchObject({ title: "--follow-up", tags: ["--meta"] });
  });

  test("combines list filters and uses a strict overdue boundary", async () => {
    const database = await freshDatabase();
    await run(database, ["add", "--title", "old", "--tags", "Ops", "--due", "2024-01-01"]);
    await run(database, ["add", "--title", "boundary", "--tags", "ops", "--due", "2024-01-02"]);
    await run(database, ["add", "--title", "done", "--tags", "ops", "--due", "2023-01-01"]);
    await run(database, ["done", "3"]);
    const result = await run(database, ["list", "--status", "open", "--tag", "OPS", "--overdue", "2024-01-02"]);
    expect(result.value.map((task: { id: number }) => task.id)).toEqual([1]);
  });

  test("done is idempotent and stats classify only open tasks as overdue", async () => {
    const database = await freshDatabase();
    await run(database, ["add", "--title", "past", "--due", "2000-01-01"]);
    await run(database, ["add", "--title", "finished past", "--due", "2000-01-01"]);
    const firstDone = await run(database, ["done", "2"]);
    const secondDone = await run(database, ["done", "2"]);
    expect(secondDone.value.completedAt).toBe(firstDone.value.completedAt);
    expect((await run(database, ["stats"])).value).toEqual({ total: 2, open: 1, done: 1, overdue: 1 });
  });

  test("reports bad input as one JSON value without modifying valid data", async () => {
    const database = await freshDatabase();
    await run(database, ["add", "--title", "keep"]);
    const before = await readFile(database, "utf8");
    for (const args of [
      ["add", "--title", "  "],
      ["add", "--title", "bad date", "--due", "2023-02-29"],
      ["add", "--title", "bad century leap date", "--due", "2100-02-29"],
      ["list", "--unknown", "x"],
      ["done", "999"],
      ["wat"],
    ]) {
      const result = await run(database, args);
      expect(result.exitCode).not.toBe(0);
      expect(typeof result.value.error).toBe("string");
      expect(result.stderr.length).toBeGreaterThan(0);
      expect(await readFile(database, "utf8")).toBe(before);
    }
  });

  test("rejects a malformed database without replacing it", async () => {
    const database = await freshDatabase();
    const malformed = "{ definitely not json\n";
    await writeFile(database, malformed);
    const result = await run(database, ["list"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.value).toEqual({ error: "Malformed task database" });
    expect(await readFile(database, "utf8")).toBe(malformed);
  });
});
