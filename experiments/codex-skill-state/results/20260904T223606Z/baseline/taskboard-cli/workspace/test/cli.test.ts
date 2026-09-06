import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directories: string[] = [];

async function sandbox(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "taskboard-cli-"));
  directories.push(directory);
  return join(directory, "tasks.json");
}

async function cli(file: string, ...args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  const child = Bun.spawn(["bun", "run", "src/cli.ts", ...args], { cwd: import.meta.dir + "/..", env: { ...process.env, TASKBOARD_FILE: file }, stdout: "pipe", stderr: "pipe" });
  return { stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text(), code: await child.exited };
}

afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe("taskboard CLI", () => {
  test("persists, filters, completes, and calculates stats", async () => {
    const file = await sandbox();
    const first = await cli(file, "add", "--title", "  First task  ", "--tags", "Work, urgent,WORK", "--due", "2020-01-01");
    expect(first.code).toBe(0);
    expect(JSON.parse(first.stdout)).toMatchObject({ id: 1, title: "First task", tags: ["work", "urgent"], status: "open", due: "2020-01-01" });
    await cli(file, "add", "--title", "Second", "--tags", "home");
    const filtered = await cli(file, "list", "--tag", "WORK", "--overdue", "2021-01-01");
    expect(JSON.parse(filtered.stdout)).toHaveLength(1);
    const completed = await cli(file, "done", "1");
    expect(JSON.parse(completed.stdout)).toMatchObject({ status: "done" });
    const repeat = await cli(file, "done", "1");
    expect(JSON.parse(repeat.stdout).completedAt).toBe(JSON.parse(completed.stdout).completedAt);
    expect(JSON.parse((await cli(file, "stats")).stdout)).toEqual({ total: 2, open: 1, done: 1, overdue: 0 });
  });

  test("rejects invalid input and preserves malformed data", async () => {
    const file = await sandbox();
    expect((await cli(file, "add", "--title", "", "--due", "2026-02-30")).code).not.toBe(0);
    await writeFile(file, "not json");
    const result = await cli(file, "list");
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("Malformed database");
    expect(await Bun.file(file).text()).toBe("not json");
  });
});
