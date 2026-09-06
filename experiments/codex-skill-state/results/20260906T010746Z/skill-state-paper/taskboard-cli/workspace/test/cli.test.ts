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
  const invoke = (args: string[]) => Bun.spawnSync(["bun", "run", cli, ...args], { cwd: directory, env: { ...process.env, TASKBOARD_FILE: file }, stdout: "pipe", stderr: "pipe" });
  return { directory, file, invoke };
}

function json(process: ReturnType<typeof Bun.spawnSync>) {
  expect(process.exitCode).toBe(0);
  return JSON.parse(process.stdout.toString());
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("taskboard CLI", () => {
  test("persists tasks across processes, normalizes tags, and keeps IDs stable", async () => {
    const { invoke } = await setup();
    const first = json(invoke(["add", "--title", " First ", "--tags", "Work, work,HOME", "--due", "2025-01-02"]));
    expect(first).toMatchObject({ id: 1, title: "First", status: "open", tags: ["work", "home"], due: "2025-01-02" });
    json(invoke(["delete", "1"]));
    expect(json(invoke(["add", "--title", "Second"])).id).toBe(2);
  });

  test("combines list filters and sorts by id", async () => {
    const { invoke } = await setup();
    json(invoke(["add", "--title", "A", "--tags", "x", "--due", "2024-01-01"]));
    json(invoke(["add", "--title", "B", "--tags", "x", "--due", "2030-01-01"]));
    json(invoke(["done", "2"]));
    expect(json(invoke(["list", "--status", "open", "--tag", "X", "--overdue", "2025-01-01"])).map((task: { id: number }) => task.id)).toEqual([1]);
  });

  test("done is idempotent and stats are correct", async () => {
    const { invoke } = await setup();
    json(invoke(["add", "--title", "Late", "--due", "2000-01-01"]));
    json(invoke(["add", "--title", "Done"]));
    const once = json(invoke(["done", "2"]));
    const twice = json(invoke(["done", "2"]));
    expect(twice.completedAt).toBe(once.completedAt);
    expect(json(invoke(["stats"]))).toEqual({ total: 2, open: 1, done: 1, overdue: 1 });
  });

  test("rejects invalid input and preserves malformed databases", async () => {
    const { file, invoke } = await setup();
    expect(invoke(["add", "--title", "x", "--due", "2025-02-29"]).exitCode).not.toBe(0);
    expect(invoke(["wat"]).exitCode).not.toBe(0);
    await writeFile(file, "not json");
    expect(invoke(["add", "--title", "x"]).exitCode).not.toBe(0);
    expect(await readFile(file, "utf8")).toBe("not json");
  });

  test("prints one JSON value on successful invocations", async () => {
    const { invoke } = await setup();
    const process = invoke(["list"]);
    expect(process.stderr.toString()).toBe("");
    expect(process.stdout.toString()).toBe("[]\n");
  });
});
