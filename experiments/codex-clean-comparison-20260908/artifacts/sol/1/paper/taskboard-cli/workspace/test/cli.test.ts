import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const cli = join(import.meta.dir, "..", "src", "cli.ts");
const directories: string[] = [];

async function run(args: string[], database?: string) {
  const directory = await mkdtemp(join(tmpdir(), "taskboard-test-"));
  directories.push(directory);
  const file = database ?? join(directory, "tasks.json");
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
  return { stdout, stderr, exitCode, file };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("taskboard CLI", () => {
  test("persists, filters, completes, and deletes tasks across processes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "taskboard-shared-"));
    directories.push(directory);
    const file = join(directory, "tasks.json");

    const first = await run(["add", "--title", " First task ", "--tags", "Work, work, Urgent", "--due", "2000-01-01"], file);
    expect(first.exitCode).toBe(0);
    expect(JSON.parse(first.stdout)).toMatchObject({ id: 1, title: "First task", status: "open", tags: ["work", "urgent"] });

    const second = await run(["add", "--title", "Second"], file);
    expect(JSON.parse(second.stdout).id).toBe(2);

    const listed = await run(["list", "--tag", "WORK", "--overdue", "2001-01-01"], file);
    expect(JSON.parse(listed.stdout).map((task: { id: number }) => task.id)).toEqual([1]);

    const completed = await run(["done", "1"], file);
    expect(JSON.parse(completed.stdout)).toMatchObject({ id: 1, status: "done" });
    const completedAgain = await run(["done", "1"], file);
    expect(JSON.parse(completedAgain.stdout).completedAt).toBe(JSON.parse(completed.stdout).completedAt);

    const removed = await run(["delete", "2"], file);
    expect(JSON.parse(removed.stdout).id).toBe(2);
    const third = await run(["add", "--title", "Third"], file);
    expect(JSON.parse(third.stdout).id).toBe(3);
  });

  test("reports stats and rejects bad input without replacing data", async () => {
    const directory = await mkdtemp(join(tmpdir(), "taskboard-errors-"));
    directories.push(directory);
    const file = join(directory, "tasks.json");
    await writeFile(file, "not json\n");

    const malformed = await run(["list"], file);
    expect(malformed.exitCode).not.toBe(0);
    expect(JSON.parse(malformed.stdout).error).toContain("malformed");
    expect(malformed.stderr).toContain("malformed");
    expect(await readFile(file, "utf8")).toBe("not json\n");

    const invalidDate = await run(["add", "--title", "Bad", "--due", "2025-02-29"]);
    expect(invalidDate.exitCode).not.toBe(0);
    expect(JSON.parse(invalidDate.stdout)).toHaveProperty("error");
  });
});
