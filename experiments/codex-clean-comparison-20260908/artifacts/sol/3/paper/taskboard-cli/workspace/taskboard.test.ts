import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

let directory: string;
let dataFile: string;

async function cli(...args: string[]) {
  const result = Bun.spawnSync([process.execPath, "run", join(import.meta.dir, "taskboard.ts"), ...args], {
    env: { ...process.env, TASKBOARD_FILE: dataFile },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "taskboard-test-"));
  dataFile = join(directory, "nested", "board.json");
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("taskboard CLI", () => {
  test("starts empty and prints help", async () => {
    expect((await cli("list")).stdout).toBe("No tasks.\n");
    expect((await cli("help")).stdout).toContain("taskboard add <title>");
  });

  test("adds, lists, shows, edits, and moves tasks", async () => {
    const added = await cli("add", "Write", "tests", "-d", "cover the CLI", "--json");
    expect(added.code).toBe(0);
    expect(JSON.parse(added.stdout)).toMatchObject({ id: 1, title: "Write tests", description: "cover the CLI", status: "todo" });

    expect((await cli("list")).stdout).toContain("#1 [todo] Write tests");
    expect(JSON.parse((await cli("show", "1", "--json")).stdout).title).toBe("Write tests");

    expect((await cli("edit", "1", "--title", "Ship CLI")).code).toBe(0);
    expect((await cli("move", "1", "done")).code).toBe(0);
    expect(JSON.parse((await cli("list", "--status", "done", "--json")).stdout)[0]).toMatchObject({ title: "Ship CLI", status: "done" });
  });

  test("reports stats and preserves monotonically increasing ids", async () => {
    await cli("add", "First");
    await cli("add", "Second", "--status", "in-progress");
    await cli("move", "1", "done");
    expect(JSON.parse((await cli("stats", "--json")).stdout)).toEqual({ total: 2, todo: 0, "in-progress": 1, done: 1 });
    await cli("remove", "1");
    expect(JSON.parse((await cli("add", "Third", "--json")).stdout).id).toBe(3);
  });

  test("rejects bad input without changing data", async () => {
    expect((await cli("add", "Task", "--status", "blocked")).code).toBe(1);
    expect((await cli("move", "99", "done")).stderr).toContain("task 99 not found");
    expect((await cli("clear")).stderr).toContain("requires --yes");
    expect(JSON.parse((await cli("list", "--json")).stdout)).toEqual([]);
  });

  test("fails safely when the data file is corrupt", async () => {
    await Bun.write(dataFile, "not json");
    const result = await cli("list");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("cannot read");
  });
});
