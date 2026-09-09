import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const cli = join(import.meta.dir, "..", "src", "cli.ts");
const directories: string[] = [];

async function fixture(): Promise<{ directory: string; file: string }> {
  const directory = await mkdtemp(join(tmpdir(), "taskboard-test-"));
  directories.push(directory);
  return { directory, file: join(directory, "board.json") };
}

async function invoke(file: string, ...args: string[]) {
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
  return { value: JSON.parse(stdout), stdout, stderr, exitCode };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("taskboard CLI", () => {
  test("persists tasks, normalizes tags, filters, completes idempotently, and deletes", async () => {
    const { file } = await fixture();
    const first = await invoke(file, "add", "--title", "  Ship CLI  ", "--tags", "Work, work, URGENT", "--due", "2000-01-01");
    expect(first.exitCode).toBe(0);
    expect(first.value).toMatchObject({ id: 1, title: "Ship CLI", status: "open", tags: ["work", "urgent"], due: "2000-01-01" });
    expect(first.stdout.trim().split("\n")).toHaveLength(1);

    const second = await invoke(file, "add", "--title", "Later", "--tags", "personal");
    expect(second.value.id).toBe(2);
    expect((await invoke(file, "list", "--status", "open", "--tag", "WORK")).value.map((task: any) => task.id)).toEqual([1]);
    expect((await invoke(file, "list", "--overdue", "2001-01-01")).value.map((task: any) => task.id)).toEqual([1]);

    const completed = await invoke(file, "done", "1");
    const completedAgain = await invoke(file, "done", "1");
    expect(completed.value.status).toBe("done");
    expect(completedAgain.value.completedAt).toBe(completed.value.completedAt);
    expect((await invoke(file, "stats")).value).toEqual({ total: 2, open: 1, done: 1, overdue: 0 });

    expect((await invoke(file, "delete", "1")).value.id).toBe(1);
    expect((await invoke(file, "list")).value.map((task: any) => task.id)).toEqual([2]);
    expect((await invoke(file, "add", "--title", "Stable ID")).value.id).toBe(3);
  });

  test("rejects invalid input and leaves existing data unchanged", async () => {
    const { file } = await fixture();
    await invoke(file, "add", "--title", "Keep me");
    const before = await readFile(file, "utf8");
    for (const args of [
      ["add", "--title", "  "],
      ["add", "--title", "bad date", "--due", "2023-02-29"],
      ["list", "--wat", "x"],
      ["done", "99"],
      ["unknown"],
    ]) {
      const result = await invoke(file, ...args);
      expect(result.exitCode).not.toBe(0);
      expect(result.value.error).toBeString();
      expect(result.stderr).not.toBeEmpty();
      expect(result.stdout.trim().split("\n")).toHaveLength(1);
      expect(await readFile(file, "utf8")).toBe(before);
    }
  });

  test("refuses a malformed database without replacing it", async () => {
    const { file } = await fixture();
    const malformed = "{ definitely not json\n";
    await writeFile(file, malformed);
    const result = await invoke(file, "add", "--title", "No overwrite");
    expect(result.exitCode).not.toBe(0);
    expect(result.value).toEqual({ error: "Malformed taskboard database" });
    expect(await readFile(file, "utf8")).toBe(malformed);
  });
});
