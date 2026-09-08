import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const cli = join(import.meta.dir, "..", "src", "cli.ts");
const directories: string[] = [];

async function run(args: string[], file: string) {
  const process = Bun.spawn(["bun", "run", cli, ...args], {
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

async function freshFile() {
  const directory = await mkdtemp(join(tmpdir(), "taskboard-test-"));
  directories.push(directory);
  return join(directory, "board.json");
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("taskboard CLI", () => {
  test("adds, normalizes, persists, lists, completes, and deletes tasks", async () => {
    const file = await freshFile();
    const first = await run(["add", "--title", " First task ", "--tags", "Work, work, Urgent", "--due", "2020-01-02"], file);
    expect(first.exitCode).toBe(0);
    expect(first.value).toMatchObject({ id: 1, title: "First task", status: "open", tags: ["work", "urgent"], due: "2020-01-02" });
    const second = await run(["add", "--title", "Second"], file);
    expect(second.value.id).toBe(2);
    expect((await run(["list", "--status", "open", "--tag", "WORK", "--overdue", "2020-01-03"], file)).value.map((task: { id: number }) => task.id)).toEqual([1]);

    const completed = await run(["done", "1"], file);
    expect(completed.value.status).toBe("done");
    const completedAt = completed.value.completedAt;
    expect((await run(["done", "1"], file)).value.completedAt).toBe(completedAt);
    expect((await run(["stats"], file)).value).toEqual({ total: 2, open: 1, done: 1, overdue: 0 });
    expect((await run(["delete", "2"], file)).value.id).toBe(2);
    expect((await run(["list"], file)).value.map((task: { id: number }) => task.id)).toEqual([1]);
  });

  test("rejects bad input without replacing malformed data", async () => {
    const file = await freshFile();
    expect((await run(["add", "--title", "x", "--due", "2023-02-29"], file)).exitCode).not.toBe(0);
    expect((await run(["wat"], file)).exitCode).not.toBe(0);
    await writeFile(file, "not json\n");
    const result = await run(["list"], file);
    expect(result.exitCode).not.toBe(0);
    expect(result.value.error).toContain("malformed");
    expect(await readFile(file, "utf8")).toBe("not json\n");
  });
});
