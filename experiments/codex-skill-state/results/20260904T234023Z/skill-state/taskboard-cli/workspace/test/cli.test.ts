import { afterEach, expect, test } from "bun:test";

const db = `${process.cwd()}/test-taskboard-${crypto.randomUUID()}.json`;
const cli = ["bun", "run", "src/cli.ts"];

async function call(...args: string[]) {
  const result = Bun.spawnSync([...cli, ...args], { cwd: process.cwd(), env: { ...process.env, TASKBOARD_FILE: db }, stdout: "pipe", stderr: "pipe" });
  return { exitCode: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
}

afterEach(() => { try { require("fs").unlinkSync(db); } catch {} });

test("persists, filters, completes, and reports tasks", async () => {
  let result = await call("add", "--title", " First ", "--tags", "Work, work, URGENT", "--due", "2020-02-29");
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.out)).toMatchObject({ id: 1, title: "First", tags: ["work", "urgent"], status: "open" });
  await call("add", "--title", "Second", "--due", "2030-01-01");
  result = await call("list", "--tag", "URGENT", "--overdue", "2021-01-01");
  expect(JSON.parse(result.out)).toHaveLength(1);
  result = await call("done", "1");
  expect(JSON.parse(result.out)).toMatchObject({ status: "done" });
  result = await call("stats");
  expect(JSON.parse(result.out)).toMatchObject({ total: 2, open: 1, done: 1 });
});

test("rejects invalid requests without replacing malformed data", async () => {
  await Bun.write(db, "not json");
  const result = await call("list");
  expect(result.exitCode).not.toBe(0);
  expect(result.err).toContain("Malformed database");
  expect(await Bun.file(db).text()).toBe("not json");
});
