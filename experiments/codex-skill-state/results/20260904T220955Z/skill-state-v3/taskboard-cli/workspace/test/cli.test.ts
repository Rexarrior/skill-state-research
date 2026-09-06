import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
let dir: string;
let database: string;

function setup() {
  dir = mkdtempSync(join(tmpdir(), "taskboard-test-"));
  database = join(dir, "tasks.json");
}

async function run(...args: string[]) {
  const proc = Bun.spawn(["bun", "run", join(root, "src/cli.ts"), ...args], { env: { ...process.env, TASKBOARD_FILE: database }, stdout: "pipe", stderr: "pipe" });
  return { exitCode: await proc.exited, out: await new Response(proc.stdout).text(), err: await new Response(proc.stderr).text() };
}

test("task lifecycle, filters, and persistence", async () => {
  setup();
  try {
    let result = await run("add", "--title", "  First task  ", "--tags", "Work,work, Urgent", "--due", "2020-01-01");
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.out)).toMatchObject({ id: 1, title: "First task", status: "open", tags: ["work", "urgent"], due: "2020-01-01" });
    result = await run("add", "--title", "Second");
    expect(JSON.parse(result.out).id).toBe(2);
    result = await run("list", "--tag", "WORK", "--overdue", "2021-01-01");
    expect(JSON.parse(result.out)).toHaveLength(1);
    result = await run("done", "1");
    const completed = JSON.parse(result.out);
    expect(completed.status).toBe("done");
    result = await run("done", "1");
    expect(JSON.parse(result.out).completedAt).toBe(completed.completedAt);
    expect(JSON.parse(readFileSync(database, "utf8")).tasks).toHaveLength(2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("invalid input and malformed data do not overwrite the database", async () => {
  setup();
  try {
    writeFileSync(database, "{not json");
    const result = await run("add", "--title", "Nope");
    expect(result.exitCode).not.toBe(0);
    expect(result.out).toBe("");
    expect(readFileSync(database, "utf8")).toBe("{not json");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
