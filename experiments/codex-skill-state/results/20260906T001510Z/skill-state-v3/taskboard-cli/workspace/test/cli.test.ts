import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const cli = join(import.meta.dir, "..", "src", "cli.ts");
const directories: string[] = [];

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "taskboard-test-"));
  directories.push(directory);
  const file = join(directory, "board.json");
  const run = (args: string[]) => Bun.spawnSync(["bun", "run", cli, ...args], {
    cwd: directory,
    env: { ...process.env, TASKBOARD_FILE: file },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { directory, file, run };
}

function output(result: ReturnType<typeof Bun.spawnSync>) {
  return JSON.parse(result.stdout.toString());
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("taskboard CLI", () => {
  test("persists tasks, normalizes tags, filters, and keeps increasing ids", async () => {
    const { run } = await setup();
    const first = run(["add", "--title", " First task ", "--tags", "Work, work, HOME", "--due", "2020-02-29"]);
    expect(first.exitCode).toBe(0);
    expect(first.stderr.toString()).toBe("");
    expect(output(first)).toMatchObject({ id: 1, title: "First task", status: "open", tags: ["work", "home"], due: "2020-02-29" });

    expect(output(run(["add", "--title", "Second"]))).toMatchObject({ id: 2, tags: [] });
    expect(output(run(["list", "--tag", "WORK"])).map((task: { id: number }) => task.id)).toEqual([1]);
    expect(output(run(["list", "--overdue", "2020-03-01"])).map((task: { id: number }) => task.id)).toEqual([1]);
    expect(output(run(["delete", "1"]))).toMatchObject({ id: 1 });
    expect(output(run(["add", "--title", "Third"]))).toMatchObject({ id: 3 });
  });

  test("done is idempotent and stats reflect current data", async () => {
    const { run } = await setup();
    run(["add", "--title", "Old", "--due", "2000-01-01"]);
    run(["add", "--title", "Current"]);
    const firstDone = output(run(["done", "2"]));
    const secondDone = output(run(["done", "2"]));
    expect(firstDone.completedAt).toBe(secondDone.completedAt);
    expect(output(run(["stats"]))).toEqual({ total: 2, open: 1, done: 1, overdue: 1 });
    expect(output(run(["list", "--status", "done"])).map((task: { id: number }) => task.id)).toEqual([2]);
  });

  test("rejects bad input and malformed storage without replacing it", async () => {
    const { file, run } = await setup();
    for (const args of [
      ["add", "--title", "  "],
      ["add", "--title", "x", "--due", "2023-02-29"],
      ["list", "--wat", "x"],
      ["done", "99"],
      ["unknown"],
    ]) {
      const result = run(args);
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout.toString()).toBe("");
      expect(result.stderr.toString().length).toBeGreaterThan(0);
    }

    await writeFile(file, "not json\n");
    const malformed = run(["list"]);
    expect(malformed.exitCode).not.toBe(0);
    expect(malformed.stdout.toString()).toBe("");
    expect(await readFile(file, "utf8")).toBe("not json\n");
  });
});
